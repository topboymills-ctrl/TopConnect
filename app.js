const bus = new BroadcastChannel("top_connect_channel");
let me = null;
let chatPeer = null;
let viewingProfileUser = null;
let activeTag = "ALL";
let stagedMedia = null;
let stagedAvatar = null;
let stagedAppBg = null;
let stagedChatBg = null;
let storyQueue = [];
let storyIdx = 0;
let vibesSoundOn = false;

// Voice Note
let mediaRecorder = null;
let audioChunks = [];

// WebRTC
let pc = null;
let stream = null;
let callPeer = null;
let pendingOffer = null;
let videoEnabled = true;
const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];

document.addEventListener("DOMContentLoaded", async () => {
  await TopConnectDB.init();
  wireEvents();

  const saved = sessionStorage.getItem("tc_active_user");
  if (saved) {
    const u = await TopConnectDB.get("users", saved);
    if (u) startSession(u);
  }
});

function emit(type, data = {}) {
  bus.postMessage({ type, data, from: me?.username });
}

bus.onmessage = async (ev) => {
  if (!me) return;
  const { type, data } = ev.data;

  if (type === "SYNC") {
    const freshMe = await TopConnectDB.get("users", me.username);
    if (freshMe) me = freshMe;
    await deliverPendingMessages();
    if (chatPeer) await readActiveMessages(chatPeer);
    renderUI();
  }
  if (type === "OFFER" && data.to === me.username) onIncomingCall(data);
  if (type === "ANSWER" && data.to === me.username && pc) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    document.getElementById("call-status-msg").textContent = "Connected";
  }
  if (type === "CANDIDATE" && data.to === me.username && pc) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  }
  if (type === "HANGUP" && data.to === me.username) teardownCall();
};

function wireEvents() {
  // Auth tabs
  document.getElementById("tab-login").onclick = () => {
    document.getElementById("tab-login").classList.add("active");
    document.getElementById("tab-signup").classList.remove("active");
    document.getElementById("login-form").classList.remove("hidden");
    document.getElementById("signup-form").classList.add("hidden");
  };
  document.getElementById("tab-signup").onclick = () => {
    document.getElementById("tab-signup").classList.add("active");
    document.getElementById("tab-login").classList.remove("active");
    document.getElementById("signup-form").classList.remove("hidden");
    document.getElementById("login-form").classList.add("hidden");
  };

  document.getElementById("login-form").onsubmit = async (e) => {
    e.preventDefault();
    const u = document.getElementById("login-user").value.trim().toLowerCase();
    const p = document.getElementById("login-pass").value;
    const found = await TopConnectDB.get("users", u);
    if (!found || found.password !== p) return alert("Wrong username or password.");
    startSession(found);
  };

  document.getElementById("signup-form").onsubmit = async (e) => {
    e.preventDefault();
    const email = document.getElementById("reg-email").value.trim();
    const username = document.getElementById("reg-user").value.trim().toLowerCase();
    const city = document.getElementById("reg-city").value.trim();
    const password = document.getElementById("reg-pass").value;
    if (await TopConnectDB.get("users", username)) return alert("Username already exists.");

    const user = {
      username, email, city, password,
      bio: `On Top Connect from ${city} ⚡`,
      wallet: 100, friends: [], requests: [], blueTicks: true,
      avatar: null, appBgMode: "default", chatBgMode: "default",
      appBgImage: null, chatBgImage: null
    };
    await TopConnectDB.put("users", user);
    emit("SYNC");
    startSession(user);
  };

  document.getElementById("logout-btn").onclick = () => {
    sessionStorage.removeItem("tc_active_user");
    me = null;
    chatPeer = null;
    document.getElementById("app-shell").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
  };

  // Bottom navigation
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(btn.dataset.screen).classList.add("active");

      if (btn.dataset.screen === "screen-chat" && chatPeer) {
        readActiveMessages(chatPeer);
      }
      if (btn.dataset.screen === "screen-profile" && me) {
        if (!viewingProfileUser) viewingProfileUser = me.username;
        renderProfile();
      }
    };
  });

  // Data saver
  document.getElementById("saver-btn").onclick = (e) => {
    const on = document.body.classList.toggle("data-saver");
    e.target.textContent = `📶 Saver: ${on ? "ON" : "OFF"}`;
  };

  // Tag filters
  document.querySelectorAll(".filter-pill[data-tag]").forEach((pill) => {
    pill.onclick = () => {
      document.querySelectorAll(".filter-pill[data-tag]").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      activeTag = pill.dataset.tag;
      renderFeed();
    };
  });

  // AI Auto-News button
  document.getElementById("ai-auto-news-btn").onclick = async () => {
    const topics = [
      { tag: "Gist", city: "Accra", text: "🤖 AI Auto-News: Creator communities, local tech builders, and city meetups are trending across Ghana today." },
      { tag: "Vibes", city: "Kumasi", text: "🤖 AI Auto-News: Afrobeats clips, street style, and short video vibes are getting top engagement right now." },
      { tag: "Hustle", city: "Takoradi", text: "🤖 AI Auto-News: Small businesses sharing quick product demos & voice replies are seeing strong reach today." }
    ];
    const pick = topics[Math.floor(Math.random() * topics.length)];
    await TopConnectDB.put("posts", {
      id: "p_ai_" + Date.now(),
      author: "toppulse_ai",
      authorName: "TopPulse AI • Auto",
      city: pick.city,
      tag: pick.tag,
      isAI: true,
      text: pick.text,
      media: null,
      mediaType: null,
      likes: [],
      tips: 0,
      comments: [],
      time: Date.now()
    });
    emit("SYNC");
    renderUI();
  };

  // Story upload
  document.getElementById("story-upload").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await toDataURL(file);
    await TopConnectDB.put("stories", {
      id: "st_" + Date.now(),
      author: me.username,
      authorName: me.email,
      src,
      type: file.type.startsWith("video") ? "video" : "image",
      createdAt: Date.now()
    });
    emit("SYNC");
    renderStories();
  };

  // Fullscreen story controls
  document.getElementById("close-story-btn").onclick = () => {
    document.getElementById("story-modal").classList.add("hidden");
  };
  document.getElementById("story-next-zone").onclick = () => stepStory(1);
  document.getElementById("story-prev-zone").onclick = () => stepStory(-1);

  // Feed media & publish
  document.getElementById("feed-media").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const src = await toDataURL(file);
    stagedMedia = { src, type: file.type.startsWith("video") ? "video" : "image" };
    const box = document.getElementById("feed-preview");
    box.classList.remove("hidden");
    box.innerHTML = stagedMedia.type === "video"
      ? `<video src="${src}" controls></video>`
      : `<img src="${src}" alt="Preview" />`;
  };

  document.getElementById("post-btn").onclick = async () => {
    const text = document.getElementById("feed-caption").value.trim();
    const tag = document.getElementById("feed-tag").value;
    if (!text && !stagedMedia) return alert("Add text or a photo/video.");

    await TopConnectDB.put("posts", {
      id: "p_" + Date.now(),
      author: me.username,
      authorName: me.fullName,
      city: me.city,
      tag,
      text,
      media: stagedMedia?.src || null,
      mediaType: stagedMedia?.type || null,
      likes: [],
      tips: 0,
      comments: [],
      time: Date.now()
    });

    document.getElementById("feed-caption").value = "";
    document.getElementById("feed-preview").classList.add("hidden");
    stagedMedia = null;
    emit("SYNC");
    renderUI();
  };

  // Chat room actions
  document.getElementById("back-to-chats").onclick = () => {
    document.getElementById("chat-room-pane").classList.add("hidden");
    document.getElementById("chat-list-pane").classList.remove("hidden");
  };

  document.getElementById("room-form").onsubmit = async (e) => {
    e.preventDefault();
    const inp = document.getElementById("room-input");
    const text = inp.value.trim();
    if (!text || !chatPeer) return;
    await pushMessage({ text });
    inp.value = "";
  };

  document.getElementById("room-media").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file || !chatPeer) return;
    const src = await toDataURL(file);
    await pushMessage({
      text: "",
      media: src,
      mediaType: file.type.startsWith("video") ? "video" : "image"
    });
  };

  // Voice Note Recording
  document.getElementById("voice-note-btn").onclick = async (e) => {
    if (!chatPeer) return alert("Open a chat first.");

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      try {
        const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        mediaRecorder = new MediaRecorder(micStream);

        mediaRecorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) audioChunks.push(ev.data);
        };

        mediaRecorder.onstop = async () => {
          micStream.getTracks().forEach((t) => t.stop());
          const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || "audio/webm" });
          const audioDataUrl = await toDataURL(blob);
          await pushMessage({ text: "", audio: audioDataUrl });
        };

        mediaRecorder.start();
        e.currentTarget.classList.add("recording");
        e.currentTarget.textContent = "⏹";
      } catch {
        alert("Microphone permission denied or unavailable.");
      }
    } else {
      mediaRecorder.stop();
      e.currentTarget.classList.remove("recording");
      e.currentTarget.textContent = "🎤";
    }
  };

  // Settings media staging
  document.getElementById("cfg-avatar-file").onchange = async (e) => {
    if (e.target.files[0]) stagedAvatar = await toDataURL(e.target.files[0]);
  };
  document.getElementById("cfg-app-bg-file").onchange = async (e) => {
    if (e.target.files[0]) {
      stagedAppBg = await toDataURL(e.target.files[0]);
      document.getElementById("cfg-app-bg").value = "custom";
    }
  };
  document.getElementById("cfg-chat-bg-file").onchange = async (e) => {
    if (e.target.files[0]) {
      stagedChatBg = await toDataURL(e.target.files[0]);
      document.getElementById("cfg-chat-bg").value = "custom";
    }
  };

  // Save Settings
  document.getElementById("save-cfg-btn").onclick = async () => {
    me.fullName = document.getElementById("cfg-name").value.trim() || me.fullName;
    me.city = document.getElementById("cfg-city").value.trim() || me.city;
    me.bio = document.getElementById("cfg-bio").value.trim();
    me.blueTicks = document.getElementById("cfg-blue-ticks").checked;
    me.appBgMode = document.getElementById("cfg-app-bg").value;
    me.chatBgMode = document.getElementById("cfg-chat-bg").value;
    if (stagedAvatar) me.avatar = stagedAvatar;
    if (stagedAppBg) me.appBgImage = stagedAppBg;
    if (stagedChatBg) me.chatBgImage = stagedChatBg;

    document.body.classList.toggle("light-mode", !document.getElementById("cfg-dark").checked);
    await TopConnectDB.put("users", me);
    stagedAvatar = null;
    stagedAppBg = null;
    stagedChatBg = null;
    emit("SYNC");
    renderUI();
    alert("Saved.");
  };

  document.getElementById("reset-db-btn").onclick = () => {
    indexedDB.deleteDatabase(TC_DB_NAME);
    sessionStorage.clear();
    location.reload();
  };

  // Calls
  document.getElementById("btn-voice-call").onclick = () => startCall(false);
  document.getElementById("btn-video-call").onclick = () => startCall(true);
  document.getElementById("answer-call-btn").onclick = answerCall;
  document.getElementById("hangup-call-btn").onclick = hangupCall;
  document.getElementById("mute-audio-btn").onclick = (e) => {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    e.target.textContent = track.enabled ? "🎙️ Mute" : "🔇 Unmute";
  };
}

async function quickLogin(username) {
  const u = await TopConnectDB.get("users", username);
  if (u) startSession(u);
}

async function startSession(user) {
  me = user;
  viewingProfileUser = user.username;
  sessionStorage.setItem("tc_active_user", user.username);
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  await deliverPendingMessages();
  emit("SYNC");
  renderUI();
}

function applyCustomVisuals() {
  const screenBox = document.getElementById("screen-container");
  screenBox.classList.remove("bg-midnight", "bg-sunset");
  screenBox.style.backgroundImage = "";

  const appBgMode = me.appBgMode || "default";
  if (appBgMode === "midnight") screenBox.classList.add("bg-midnight");
  else if (appBgMode === "sunset") screenBox.classList.add("bg-sunset");
  else if (appBgMode === "custom" && me.appBgImage) {
    screenBox.style.backgroundImage = `url(${me.appBgImage})`;
    screenBox.style.backgroundSize = "cover";
    screenBox.style.backgroundPosition = "center";
  }

  const roomBox = document.getElementById("room-messages");
  roomBox.classList.remove("chat-bg-emerald", "chat-bg-warm");
  roomBox.style.backgroundImage = "";

  const chatBgMode = me.chatBgMode || "default";
  if (chatBgMode === "emerald") roomBox.classList.add("chat-bg-emerald");
  else if (chatBgMode === "warm") roomBox.classList.add("chat-bg-warm");
  else if (chatBgMode === "custom" && me.chatBgImage) {
    roomBox.style.backgroundImage = `url(${me.chatBgImage})`;
    roomBox.style.backgroundSize = "cover";
    roomBox.style.backgroundPosition = "center";
  }

  const avatarImg = me.avatar ? `<img src="${me.avatar}" class="avatar-sm" alt="" />` : "";
  document.getElementById("header-user-tag").innerHTML = `${avatarImg}@${esc(me.username)} • ${esc(me.city)}`;
}

function renderUI() {
  if (!me) return;
  document.getElementById("wallet-chip").textContent = `₵${Number(me.wallet || 0).toFixed(2)}`;

  document.getElementById("cfg-name").value = me.fullName;
  document.getElementById("cfg-city").value = me.city;
  document.getElementById("cfg-bio").value = me.bio || "";
  document.getElementById("cfg-blue-ticks").checked = me.blueTicks !== false;
  document.getElementById("cfg-app-bg").value = me.appBgMode || "default";
  document.getElementById("cfg-chat-bg").value = me.chatBgMode || "default";

  applyCustomVisuals();
  renderStories();
  renderFeed();
  renderVibes();
  renderFriends();
  renderChatThreads();
  renderProfile();
  if (chatPeer) renderRoomMessages();
}

/* STORIES */
async function renderStories() {
  const all = await TopConnectDB.getAll("stories");
  storyQueue = all.filter((s) => Date.now() - s.createdAt < 86400000);
  const strip = document.getElementById("stories-strip");

  strip.innerHTML = storyQueue.map((s, i) => `
    <div class="story-card" onclick="openStoryAt(${i})">
      <div class="story-ring">
        ${s.type === "video"
          ? `<div class="story-thumb">▶</div>`
          : `<img class="story-thumb" src="${s.src}" alt="" />`}
      </div>
      <span>${esc(s.authorName.split(" ")[0])}</span>
    </div>
  `).join("");
}

function openStoryAt(index) {
  if (!storyQueue[index]) return;
  storyIdx = index;
  const s = storyQueue[storyIdx];
  document.getElementById("story-author-name").textContent = s.authorName;
  document.getElementById("story-time-ago").textContent = "Just now";
  document.getElementById("story-stage").innerHTML = s.type === "video"
    ? `<video src="${s.src}" autoplay controls playsinline></video>`
    : `<img src="${s.src}" alt="Story" />`;
  document.getElementById("story-modal").classList.remove("hidden");
}

function stepStory(dir) {
  const next = storyIdx + dir;
  if (next >= 0 && next < storyQueue.length) openStoryAt(next);
  else document.getElementById("story-modal").classList.add("hidden");
}

/* FEED */
async function renderFeed() {
  let posts = (await TopConnectDB.getAll("posts")).sort((a, b) => b.time - a.time);
  if (activeTag !== "ALL") posts = posts.filter((p) => p.tag === activeTag);

  document.getElementById("posts-feed").innerHTML = posts.map((p) => {
    const likes = Array.isArray(p.likes) ? p.likes : [];
    const comments = Array.isArray(p.comments) ? p.comments : [];
    const liked = likes.includes(me.username);

    return `
      <article class="surface-card">
        <div class="post-top">
          <div>
            <div class="post-author" onclick="openUserProfile('${esc(p.author)}')">${esc(p.authorName)}</div>
            <div class="post-sub">@${esc(p.author)} • ${esc(p.city)}</div>
          </div>
          <span class="post-badge">${esc(p.tag)}</span>
        </div>
        ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
        ${p.media ? `<div class="post-media">${p.mediaType === "video"
          ? `<video src="${p.media}" controls playsinline></video>`
          : `<img src="${p.media}" alt="" />`}</div>` : ""}
        <div class="post-bar">
          <button type="button" onclick="likePost('${p.id}')">${liked ? "❤️" : "🤍"} ${likes.length}</button>
          <button type="button" onclick="tipPost('${p.id}')">💸 Tip ₵5 (₵${p.tips || 0})</button>
        </div>
        <div class="comments-wrap">
          ${comments.map((c) => `<div class="comment-line"><strong>${esc(c.by)}:</strong> ${esc(c.text)}</div>`).join("")}
          <form class="comment-add" onsubmit="commentPost(event, '${p.id}')">
            <input type="text" placeholder="Add a comment..." required />
            <button type="submit">Post</button>
          </form>
        </div>
      </article>
    `;
  }).join("");
}

/* VIBES */
async function renderVibes() {
  const mediaPosts = (await TopConnectDB.getAll("posts"))
    .filter((p) => p.media)
    .sort((a, b) => b.time - a.time);

  const el = document.getElementById("vibes-stream");
  if (!mediaPosts.length) {
    el.innerHTML = `<div class="surface-card"><p class="post-sub">No photo or video vibes yet. Upload one in Feed!</p></div>`;
    return;
  }

  el.innerHTML = mediaPosts.map((p, idx) => `
    <div class="vibe-card">
      <div class="vibe-media-wrap">
        ${p.mediaType === "video"
          ? `<video src="${p.media}" autoplay loop playsinline ${vibesSoundOn ? "" : "muted"} onclick="toggleVibeSound()"></video>
             <button type="button" class="vibe-sound-btn" id="vibe-snd-btn-${idx}" onclick="toggleVibeSound()">${vibesSoundOn ? "🔊 Sound ON" : "🔇 Tap for Sound"}</button>`
          : `<img src="${p.media}" alt="" />`}
      </div>
      <div class="vibe-overlay">
        <strong>@${esc(p.author)}</strong> • <span class="post-sub">${esc(p.city)}</span>
        ${p.text ? `<p class="post-text" style="margin-top:4px;">${esc(p.text)}</p>` : ""}
        <div class="post-bar">
          <button type="button" onclick="likePost('${p.id}')">❤️ ${(p.likes || []).length}</button>
          <button type="button" onclick="tipPost('${p.id}')">💸 Tip ₵5</button>
        </div>
      </div>
    </div>
  `).join("");
}

function toggleVibeSound() {
  vibesSoundOn = !vibesSoundOn;
  document.querySelectorAll(".vibe-media-wrap video").forEach((vid) => {
    vid.muted = !vibesSoundOn;
    if (vibesSoundOn) vid.play().catch(() => {});
  });
  document.querySelectorAll(".vibe-sound-btn").forEach((btn) => {
    btn.textContent = vibesSoundOn ? "🔊 Sound ON" : "🔇 Tap for Sound";
  });
}

async function likePost(id) {
  const p = await TopConnectDB.get("posts", id);
  if (!p) return;
  p.likes = Array.isArray(p.likes) ? p.likes : [];
  const i = p.likes.indexOf(me.username);
  if (i > -1) p.likes.splice(i, 1);
  else p.likes.push(me.username);
  await TopConnectDB.put("posts", p);
  emit("SYNC");
  renderUI();
}

async function tipPost(id) {
  const freshMe = await TopConnectDB.get("users", me.username);
  if (!freshMe || (freshMe.wallet || 0) < 5) return alert("Balance below ₵5.");
  const p = await TopConnectDB.get("posts", id);
  if (!p) return;

  freshMe.wallet = Number(freshMe.wallet) - 5;
  me = freshMe;
  p.tips = Number(p.tips || 0) + 5;

  await TopConnectDB.put("users", freshMe);
  await TopConnectDB.put("posts", p);

  if (p.author && p.author !== freshMe.username) {
    const author = await TopConnectDB.get("users", p.author);
    if (author) {
      author.wallet = Number(author.wallet || 0) + 5;
      await TopConnectDB.put("users", author);
    }
  }
  emit("SYNC");
  renderUI();
}

async function commentPost(e, id) {
  e.preventDefault();
  const input = e.target.querySelector("input");
  const p = await TopConnectDB.get("posts", id);
  if (!p) return;
  p.comments = Array.isArray(p.comments) ? p.comments : [];
  p.comments.push({ by: me.fullName, text: input.value.trim() });
  await TopConnectDB.put("posts", p);
  emit("SYNC");
  renderUI();
}

/* PROFILE */
async function openUserProfile(username) {
  viewingProfileUser = username;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.screen === "screen-profile");
  });
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById("screen-profile").classList.add("active");
  await renderProfile();
}

async function renderProfile() {
  if (!me) return;
  const targetName = viewingProfileUser || me.username;
  const profileUser = await TopConnectDB.get("users", targetName);
  if (!profileUser) return;

  const userPosts = (await TopConnectDB.getAll("posts"))
    .filter((p) => p.author === profileUser.username)
    .sort((a, b) => b.time - a.time);

  const avatarEl = profileUser.avatar
    ? `<img src="${profileUser.avatar}" class="avatar-lg" alt="" />`
    : `<div class="avatar-lg">👤</div>`;

  document.getElementById("profile-card").innerHTML = `
    <div class="profile-top">
      ${avatarEl}
      <div>
        <h2>${esc(profileUser.fullName)}</h2>
        <div class="post-sub">@${esc(profileUser.username)} • ${esc(profileUser.city)}</div>
      </div>
    </div>
    <p class="post-text">${esc(profileUser.bio || "")}</p>
    <div class="profile-stats">
      <span><strong>${userPosts.length}</strong> Posts</span>
      <span><strong>${(profileUser.friends || []).length}</strong> Friends</span>
      ${profileUser.username !== me.username
        ? `<button type="button" class="mini-action alt" onclick="openUserProfile('${me.username}')">My Profile</button>`
        : ""}
    </div>
  `;

  const friends = profileUser.friends || [];
  document.getElementById("profile-friends-list").innerHTML = friends.length
    ? friends.map((f) => `
        <div class="friend-row">
          <span>@${esc(f)}</span>
          <button type="button" class="mini-action alt" onclick="openUserProfile('${esc(f)}')">View</button>
        </div>
      `).join("")
    : `<p class="post-sub">No friends listed yet.</p>`;

  document.getElementById("profile-posts-list").innerHTML = userPosts.length
    ? userPosts.map((p) => `
        <article class="surface-card">
          <div class="post-top">
            <span class="post-sub">${new Date(p.time).toLocaleDateString()}</span>
            <span class="post-badge">${esc(p.tag)}</span>
          </div>
          ${p.text ? `<p class="post-text">${esc(p.text)}</p>` : ""}
          ${p.media ? `<div class="post-media">${p.mediaType === "video"
            ? `<video src="${p.media}" controls playsinline></video>`
            : `<img src="${p.media}" alt="" />`}</div>` : ""}
        </article>
      `).join("")
    : `<div class="surface-card"><p class="post-sub">No posts from @${esc(profileUser.username)} yet.</p></div>`;
}

/* FRIENDS */
async function renderFriends() {
  const users = await TopConnectDB.getAll("users");
  const reqs = me.requests || [];
  const friends = me.friends || [];

  const reqDot = document.getElementById("nav-req-dot");
  reqDot.textContent = reqs.length;
  reqDot.classList.toggle("hidden", reqs.length === 0);

  document.getElementById("requests-list").innerHTML = reqs.length
    ? reqs.map((u) => `
        <div class="friend-row">
          <span>@${esc(u)}</span>
          <button type="button" class="mini-action" onclick="acceptReq('${u}')">Accept</button>
        </div>
      `).join("")
    : `<p class="post-sub">No pending requests.</p>`;

  document.getElementById("friends-list").innerHTML = friends.length
    ? friends.map((u) => `
        <div class="friend-row">
          <span>@${esc(u)}</span>
          <button type="button" class="mini-action alt" onclick="openChatTab('${u}')">Message</button>
        </div>
      `).join("")
    : `<p class="post-sub">No friends added yet.</p>`;

  const others = users.filter((u) =>
    u.username !== me.username && !friends.includes(u.username) && !reqs.includes(u.username)
  );

  document.getElementById("suggestions-list").innerHTML = others.map((u) => {
    const sent = (u.requests || []).includes(me.username);
    return `
      <div class="friend-row">
        <div><strong>${esc(u.fullName)}</strong> <span class="post-sub">@${esc(u.username)} • ${esc(u.city)}</span></div>
        <button type="button" class="mini-action ${sent ? "alt" : ""}" ${sent ? "disabled" : ""} onclick="addReq('${u.username}')">
          ${sent ? "Sent" : "Add"}
        </button>
      </div>
    `;
  }).join("");
}

async function addReq(targetName) {
  const t = await TopConnectDB.get("users", targetName);
  if (!t) return;
  t.requests = t.requests || [];
  if (!t.requests.includes(me.username)) {
    t.requests.push(me.username);
    await TopConnectDB.put("users", t);
    emit("SYNC");
    renderFriends();
  }
}

async function acceptReq(fromName) {
  me.requests = (me.requests || []).filter((x) => x !== fromName);
  me.friends = me.friends || [];
  if (!me.friends.includes(fromName)) me.friends.push(fromName);
  await TopConnectDB.put("users", me);

  const other = await TopConnectDB.get("users", fromName);
  if (other) {
    other.friends = other.friends || [];
    if (!other.friends.includes(me.username)) {
      other.friends.push(me.username);
      await TopConnectDB.put("users", other);
    }
  }
  emit("SYNC");
  renderUI();
}

function openChatTab(username) {
  document.querySelector('[data-screen="screen-chat"]').click();
  enterRoom(username);
}

/* CHAT & TICKS */
async function renderChatThreads() {
  const users = (await TopConnectDB.getAll("users")).filter((u) => u.username !== me.username);
  const msgs = await TopConnectDB.getAll("messages");

  const unreadAll = msgs.filter((m) => m.to === me.username && m.status !== "read").length;
  const msgDot = document.getElementById("nav-msg-dot");
  msgDot.textContent = unreadAll;
  msgDot.classList.toggle("hidden", unreadAll === 0);

  document.getElementById("chat-threads-list").innerHTML = users.map((u) => {
    const unread = msgs.filter((m) => m.from === u.username && m.to === me.username && m.status !== "read").length;
    return `
      <div class="thread-item" onclick="enterRoom('${u.username}')">
        <div>
          <strong>${esc(u.fullName)}</strong>
          <div class="post-sub">@${esc(u.username)} • ${esc(u.city)}</div>
        </div>
        ${unread ? `<span class="post-badge">${unread} new</span>` : ""}
      </div>
    `;
  }).join("");
}

async function enterRoom(username) {
  chatPeer = username;
  const partner = await TopConnectDB.get("users", username);
  if (!partner) return;
  document.getElementById("room-peer-name").textContent = partner.fullName;
  document.getElementById("room-peer-sub").textContent = `@${partner.username} • ${partner.city}`;

  document.getElementById("chat-list-pane").classList.add("hidden");
  document.getElementById("chat-room-pane").classList.remove("hidden");

  await readActiveMessages(username);
  renderChatThreads();
  renderRoomMessages();
}

async function pushMessage({ text = "", media = null, mediaType = null, audio = null }) {
  await TopConnectDB.put("messages", {
    id: "m_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
    from: me.username,
    to: chatPeer,
    text,
    media,
    mediaType,
    audio,
    status: "sent",
    at: Date.now()
  });
  emit("SYNC");
  renderRoomMessages();
}

async function deliverPendingMessages() {
  const msgs = await TopConnectDB.getAll("messages");
  let updated = false;
  for (const m of msgs) {
    if (m.to === me.username && m.status === "sent") {
      m.status = "delivered";
      await TopConnectDB.put("messages", m);
      updated = true;
    }
  }
  if (updated) emit("SYNC");
}

async function readActiveMessages(partnerName) {
  const onChatScreen = document.getElementById("screen-chat").classList.contains("active");
  const roomVisible = !document.getElementById("chat-room-pane").classList.contains("hidden");
  if (!onChatScreen || !roomVisible || me.blueTicks === false) return;

  const msgs = await TopConnectDB.getAll("messages");
  let updated = false;
  for (const m of msgs) {
    if (m.from === partnerName && m.to === me.username && m.status !== "read") {
      m.status = "read";
      await TopConnectDB.put("messages", m);
      updated = true;
    }
  }
  if (updated) emit("SYNC");
}

function tickHtml(status, mine) {
  if (!mine) return "";
  if (status === "read") return `<span class="tick read">✓✓</span>`;
  if (status === "delivered") return `<span class="tick">✓✓</span>`;
  return `<span class="tick">✓</span>`;
}

async function renderRoomMessages() {
  if (!chatPeer) return;
  const msgs = (await TopConnectDB.getAll("messages"))
    .filter((m) => (m.from === me.username && m.to === chatPeer) || (m.from === chatPeer && m.to === me.username))
    .sort((a, b) => a.at - b.at);

  const box = document.getElementById("room-messages");
  box.innerHTML = msgs.map((m) => {
    const mine = m.from === me.username;
    const t = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return `
      <div class="bubble ${mine ? "mine" : ""}">
        ${m.media ? (m.mediaType === "video"
          ? `<video src="${m.media}" controls playsinline></video>`
          : `<img src="${m.media}" alt="" />`) : ""}
        ${m.audio ? `<audio src="${m.audio}" controls playsinline></audio>` : ""}
        ${m.text ? `<div>${esc(m.text)}</div>` : ""}
        <div class="bubble-foot">
          <span>${t}</span>
          ${tickHtml(m.status, mine)}
        </div>
      </div>
    `;
  }).join("");
  box.scrollTop = box.scrollHeight;
}

/* CALLS */
async function initPeer(to) {
  pc = new RTCPeerConnection({ iceServers });
  stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
  pc.ontrack = (e) => { document.getElementById("remote-stream-video").srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => {
    if (e.candidate) emit("CANDIDATE", { to, candidate: e.candidate });
  };
}

async function startCall(withVideo) {
  if (!chatPeer) return;
  videoEnabled = withVideo;
  callPeer = chatPeer;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo });
  } catch {
    return alert("Camera or mic permission blocked.");
  }

  document.getElementById("local-stream-video").srcObject = stream;
  document.getElementById("call-badge").textContent = withVideo ? "📹 Video Call" : "📞 Voice Call";
  document.getElementById("call-target").textContent = `@${callPeer}`;
  document.getElementById("call-status-msg").textContent = "Ringing...";
  document.getElementById("answer-call-btn").classList.add("hidden");
  document.getElementById("call-modal").classList.remove("hidden");

  await initPeer(callPeer);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  emit("OFFER", { to: callPeer, from: me.username, offer, withVideo });
}

function onIncomingCall(data) {
  callPeer = data.from;
  pendingOffer = data.offer;
  videoEnabled = data.withVideo;
  document.getElementById("call-badge").textContent = videoEnabled ? "📹 Incoming Video" : "📞 Incoming Voice";
  document.getElementById("call-target").textContent = `@${callPeer}`;
  document.getElementById("call-status-msg").textContent = "Incoming call...";
  document.getElementById("answer-call-btn").classList.remove("hidden");
  document.getElementById("call-modal").classList.remove("hidden");
}

async function answerCall() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: videoEnabled });
  } catch {
    return alert("Could not access mic/camera.");
  }
  document.getElementById("local-stream-video").srcObject = stream;
  document.getElementById("answer-call-btn").classList.add("hidden");
  document.getElementById("call-status-msg").textContent = "Connected";

  await initPeer(callPeer);
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  emit("ANSWER", { to: callPeer, answer });
}

function hangupCall() {
  if (callPeer) emit("HANGUP", { to: callPeer });
  teardownCall();
}

function teardownCall() {
  stream?.getTracks().forEach((t) => t.stop());
  pc?.close();
  stream = null;
  pc = null;
  callPeer = null;
  pendingOffer = null;
  document.getElementById("call-modal").classList.add("hidden");
}

function toDataURL(file) {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}