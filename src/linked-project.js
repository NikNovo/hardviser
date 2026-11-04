import { createSessionChat, createSessionProject, getRagChatSession, setSessionDraft } from './rag-chat-session.js';

export const FIRST_QUESTION = 'Review my project brief and suggest the next three steps.';

// Creates the server AI project for a local project brief, opens its first
// chat and suggests a first question without sending it. Returns the AI
// project id, or null when the server did not create it (the session keeps
// the error for the AI panel).
export async function createAiProject({ name, text }) {
  const created = await createSessionProject(name, text);
  if (!created) return null;
  const serverProjectId = created.id || getRagChatSession().selectedProjectId;
  if (!serverProjectId) return null;
  await createSessionChat();
  if (!getRagChatSession().draft.trim()) setSessionDraft(FIRST_QUESTION);
  return serverProjectId;
}
