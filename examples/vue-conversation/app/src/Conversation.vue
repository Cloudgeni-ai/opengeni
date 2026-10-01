<script setup lang="ts">
import { onMounted, ref } from "vue";
import HumanInput from "./HumanInput.vue";
import { useConversation } from "./useConversation";

const {
  sessions,
  active,
  view,
  questions,
  error,
  signedIn,
  busy,
  connection,
  pending,
  load,
  login,
  select,
  newChat,
  send,
  retry,
  approve,
  answer,
  togglePause,
  refresh,
} = useConversation();
const draft = ref("");
async function submit() {
  const text = draft.value;
  await send(text);
  if (!pending.value) draft.value = "";
}
onMounted(load);
</script>

<template>
  <div class="desk">
    <aside class="sidebar">
      <a class="brand" href="/">Harbor<span>Guest desk</span></a>
      <p class="welcome">A little help for<br />a better stay.</p>
      <template v-if="signedIn">
        <button class="new-chat" :disabled="busy" @click="newChat">New conversation</button>
        <nav aria-label="Conversations">
          <button
            v-for="session in sessions"
            :key="session.id"
            class="chat-link"
            :class="{ selected: active?.id === session.id }"
            :aria-current="active?.id === session.id ? 'page' : undefined"
            :disabled="busy"
            @click="select(session)"
          >
            {{ session.title || session.initialMessage || "Your conversation" }}
          </button>
        </nav>
      </template>
      <p class="sidebar-note">Your conversations stay with your account.</p>
    </aside>
    <main>
      <header class="topbar">
        <div>
          <h1>Your stay, made simpler</h1>
          <p>Plan a day out or ask a question.</p>
        </div>
        <span v-if="signedIn" class="connection" role="status">{{
          connection === "live"
            ? "Connected"
            : connection === "offline"
              ? "Offline"
              : "Reconnecting…"
        }}</span>
      </header>
      <div v-if="!signedIn" class="empty">
        <h2>Welcome to the guest desk</h2>
        <p>Sign in to start a conversation or return to your plans.</p>
        <button @click="login">Sign in to local demo</button>
      </div>
      <template v-else>
        <div class="conversation-heading">
          <h2>{{ active?.title || "How can we help?" }}</h2>
          <div v-if="active" class="actions">
            <span class="session-status">{{ active.status.replaceAll("_", " ") }}</span>
            <button class="secondary small" :disabled="busy" @click="refresh">Refresh</button>
            <button
              v-if="!['failed', 'cancelled'].includes(active.status)"
              class="secondary small"
              :disabled="busy"
              @click="togglePause"
            >
              {{ active.effectiveControl?.state === "paused" ? "Resume" : "Pause" }}
            </button>
          </div>
        </div>
        <section
          class="timeline"
          aria-label="Conversation messages"
          aria-live="polite"
          aria-relevant="additions text"
        >
          <div v-if="!view.messages.length" class="empty">
            <h3>Make the most of your visit.</h3>
            <p>Ask about a relaxed afternoon, family activities or a rainy-day plan.</p>
          </div>
          <article
            v-for="message in view.messages"
            :key="message.id"
            class="message"
            :class="message.role"
          >
            <h3>{{ message.role === "user" ? "You" : "Guest desk" }}</h3>
            <p>{{ message.text }}</p>
            <span v-if="message.streaming" class="streaming">Writing…</span>
          </article>
          <p v-if="view.failure" class="notice" role="alert">{{ view.failure }}</p>
          <section v-for="approval in view.approvals" :key="approval.id" class="decision">
            <h3>Allow this action?</h3>
            <p>{{ approval.name }}</p>
            <pre>{{ JSON.stringify(approval.arguments, null, 2) }}</pre>
            <div class="actions">
              <button :disabled="busy" @click="approve(approval.id, 'approve')">Approve</button
              ><button class="secondary" :disabled="busy" @click="approve(approval.id, 'reject')">
                Reject
              </button>
            </div>
          </section>
          <HumanInput
            v-for="request in questions"
            :key="request.id"
            :request="request"
            :busy="busy"
            @answer="answer(request.id, $event)"
          />
        </section>
        <p v-if="active?.effectiveControl?.state === 'paused'" class="notice">
          Paused. Messages are saved in the queue until you resume.
        </p>
        <form class="composer" @submit.prevent="submit">
          <label for="message">Message the guest desk</label>
          <div>
            <textarea
              id="message"
              v-model="draft"
              rows="3"
              placeholder="What would make your stay better?"
              :disabled="busy || !!pending"
              required
            /><button :disabled="busy || !!pending || !draft.trim()">
              {{ busy ? "Sending…" : "Send message" }}
            </button>
          </div>
        </form>
      </template>
      <div v-if="error || pending" class="notice" role="alert">
        <p>{{ error || "A saved message is waiting to be sent." }}</p>
        <button v-if="pending" class="secondary" :disabled="busy" @click="retry">
          Retry saved message
        </button>
      </div>
      <footer>Harbor guest services</footer>
    </main>
  </div>
</template>
