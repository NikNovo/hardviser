import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown,
  ClipboardList,
  FilePlus2,
  FileText,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  PinOff,
  Send,
  Trash2,
  Upload,
  Wrench,
  X,
} from 'lucide-react';
import { useWorkspace } from './store.jsx';
import { buildProjectContext } from './rag-chat-context.js';
import { createAiProject } from './linked-project.js';
import useDialogFocus from './useDialogFocus.js';
import ProjectTodos from './ProjectTodos.jsx';
import { AddTodoDialog, BRIEF_FIELDS, FileBrowserDialog, SaveBriefDialog, currentBriefField } from './RagChatDialogs.jsx';
import {
  addSessionMention,
  askMessageAsTechnical,
  clearSessionError,
  createSessionChat,
  createSessionProject,
  createSessionTodo,
  deleteSessionChat,
  deleteSessionFile,
  getRagChatSession,
  refreshSessionFiles,
  removeSessionMention,
  renameSessionChat,
  saveSessionProjectBrief,
  selectSessionChat,
  selectSessionProject,
  setSessionDraft,
  setSessionTechnicalQuestion,
  submitSessionQuestion,
  subscribeRagChatSession,
  toggleSessionFilePin,
  updateSessionProject,
  uploadSessionFile,
} from './rag-chat-session.js';
import {
  classifyFileExtension,
  fileContentHint,
  fileStatusHint,
  FILE_INPUT_ACCEPT,
  findPendingAnswer,
  formatFileSize,
  getMentionQuery,
  MAX_UPLOAD_FILE_BYTES,
  replaceMentionQuery,
  SUPPORTED_FILE_FORMAT_GROUPS,
  unicodeCharacterCount,
} from './rag-chat-helpers.js';
import './rag-chat.css';
const MAX_QUESTION_LENGTH = 4000;
const MAX_QUESTION_BYTES = 8192;
const FILE_KIND_LABELS = Object.fromEntries(
  SUPPORTED_FILE_FORMAT_GROUPS.map(({ kind, label }) => [kind, label]),
);
const CONTEXT_PANEL_WIDTH = 320;
const MIN_MAIN_WIDTH = 640;
const AUTO_CONTEXT_VIEWPORT_WIDTH = 1280;

function fileKindLabel(file) {
  const kind = file.kind || classifyFileExtension(file.name);
  return FILE_KIND_LABELS[kind] || 'File';
}


function exceedsQuestionLimit(question) {
  return unicodeCharacterCount(question) > MAX_QUESTION_LENGTH || new TextEncoder().encode(question).byteLength > MAX_QUESTION_BYTES;
}

function progressLabel(event) {
  if (event.stage === 'accepted') return 'Request accepted by the service';
  if (event.stage === 'classifying') return 'Classifying the question';
  if (event.stage === 'classified') return event.route === 'general'
    ? 'General · Project and selected files'
    : 'Technical · Project files and knowledge base';
  if (event.stage === 'project_context') return event.available
    ? 'Project brief is available'
    : 'No project brief is set';
  if (event.stage === 'reading_files') return `Reading ${event.count} project ${event.count === 1 ? 'file' : 'files'}`;
  if (event.stage === 'searching') return 'Searching the knowledge base';
  return 'Preparing the answer';
}

function ThinkingDots() {
  return (
    <span className="rag-chat-dynamic-dots" aria-label="Answer in progress">
      <span className="rag-chat-dynamic-dot" aria-hidden="true" />
      <span className="rag-chat-dynamic-dot" aria-hidden="true" />
      <span className="rag-chat-dynamic-dot" aria-hidden="true" />
    </span>
  );
}

function RequestProgress({ events }) {
  if (!events.length) {
    return <p className="rag-chat-pending" role="status">Answer in progress <ThinkingDots /></p>;
  }
  return (
    <ol className="rag-chat-progress" aria-label="Answer progress">
      {events.map((event, index) => {
        const active = index === events.length - 1;
        return (
          <li className="rag-chat-progress__item" data-active={active ? 'true' : undefined} key={`${event.stage}-${index}`}>
            <span className="rag-chat-progress__indicator" aria-hidden="true" />
            <span>
              {progressLabel(event)}
              {active && <ThinkingDots />}
            </span>
            {event.stage === 'searching' && (
              <ul className="rag-chat-progress__queries" aria-label="Search queries">
                {event.queries.map((query, queryIndex) => <li key={`${queryIndex}-${query}`}>{query}</li>)}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function normalizedAnswer(message) {
  const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
  const questions = payload.follow_up_questions || payload.followUpQuestions || {};
  return {
    route: message.route,
    answer: message.content,
    recommendations: Array.isArray(payload.recommendations) ? payload.recommendations : [],
    unknowns: Array.isArray(payload.unknowns) ? payload.unknowns : [],
    followUpQuestions: {
      general: Array.isArray(questions.general) ? questions.general : [],
      technical: Array.isArray(questions.technical) ? questions.technical : [],
    },
  };
}

function AnswerContent({
  answer,
  busy,
  actionFeedback,
  recommendationFeedback,
  onFollowUp,
  onAskAsTechnical,
  onAddToTodo,
  onSaveBrief,
  onAttachFile,
  onAddRecommendation,
}) {
  const questionGroups = [
    { key: 'general', label: 'About your project' },
    { key: 'technical', label: 'Technical questions' },
  ];
  return (
    <div className="rag-chat-answer">
      <section>
        <p className="rag-chat-answer__text">{answer.answer}</p>
      </section>
      {answer.recommendations.length > 0 && (
        <section className="rag-chat-answer__section" aria-label="Recommendations">
          <h3 className="rag-chat-section-label">What to do next</h3>
          <ul className="rag-chat-recommendations">
            {answer.recommendations.map((recommendation, index) => (
              <li key={`${index}-${recommendation}`}>
                <span>{recommendation}</span>
                <button
                  className="rag-chat-recommendation__action"
                  type="button"
                  onClick={() => onAddRecommendation(recommendation, index)}
                  disabled={recommendationFeedback[index] === 'Adding…' || busy}
                >{recommendationFeedback[index] || 'Add as task'}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {answer.unknowns.length > 0 && (
        <section className="rag-chat-answer__section" aria-label="Unknowns">
          <h3 className="rag-chat-section-label">What remains unknown</h3>
          <ul>{answer.unknowns.map((unknown, index) => <li key={`${index}-${unknown}`}>{unknown}</li>)}</ul>
        </section>
      )}
      {questionGroups.some(group => answer.followUpQuestions[group.key].length > 0) && (
        <section className="rag-chat-followups" aria-label="Follow-up questions">
          <h3 className="rag-chat-section-label">Continue with a follow-up</h3>
          {questionGroups.map(group => {
            const questions = answer.followUpQuestions[group.key];
            return questions.length > 0 ? (
              <div className="rag-chat-followups__group" key={group.key}>
                <h4>{group.label}</h4>
                <div className="rag-chat-followups__list">
                  {questions.map((question, index) => (
                    <button
                      className="rag-chat-followup"
                      type="button"
                      key={`${index}-${question}`}
                      onClick={() => onFollowUp(question)}
                      disabled={busy}
                    >
                      <span>{question}</span><Send size={14} aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null;
          })}
        </section>
      )}
      <div className="rag-chat-answer__actions" aria-label="Answer actions">
        <button className="rag-chat-answer__action rag-chat-answer__action--task" type="button" onClick={onAddToTodo} aria-label="Add to todo">
          <ClipboardList size={15} aria-hidden="true" /><span>Task</span>
        </button>
        <button className="rag-chat-answer__action rag-chat-answer__action--brief" type="button" onClick={onSaveBrief} aria-label="Save to project brief">
          <FileText size={15} aria-hidden="true" /><span>Brief</span>
        </button>
        <button className="rag-chat-answer__action rag-chat-answer__action--attach" type="button" onClick={onAttachFile} aria-label="Attach a file from the project">
          <FilePlus2 size={15} aria-hidden="true" /><span>Attach</span>
        </button>
        {answer.route === 'general' && (
          <button className="rag-chat-answer__action rag-chat-answer__action--technical" type="button" onClick={onAskAsTechnical} disabled={busy} aria-label="Ask this question as a technical question">
            <Wrench size={15} aria-hidden="true" /><span>Technical</span>
          </button>
        )}
      </div>
      {actionFeedback && <p className="rag-chat-action-feedback" role="status">{actionFeedback}</p>}
    </div>
  );
}




export default function RagChat({ expanded = false, onToggleExpanded } = {}) {
  const workspace = useWorkspace();
  const session = useSyncExternalStore(subscribeRagChatSession, getRagChatSession);
  const localProject = useMemo(
    () => buildProjectContext(workspace.activeProjectId, workspace.project, workspace.records),
    [workspace.activeProjectId, workspace.project, workspace.records],
  );
  const serverProject = session.projects.find(project => project.id === session.selectedProjectId) || null;
  const serverBriefValues = useMemo(
    () => BRIEF_FIELDS.map(([field, label]) => [field, label, currentBriefField(serverProject, field)]),
    [serverProject],
  );
  const hasServerBrief = serverBriefValues.some(([, , value]) => value.trim());
  const linkedServerProject = session.projects.find(project => project.id === workspace.linkedServerProjectId) || null;
  const [creatingAiProject, setCreatingAiProject] = useState(false);
  const [mentionQuery, setMentionQuery] = useState(null);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [contextView, setContextView] = useState('project');
  const [contextPreference, setContextPreference] = useState(null);
  const [contextAreaWidth, setContextAreaWidth] = useState(0);
  const [chatAreaHeight, setChatAreaHeight] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
  const [viewportHeight, setViewportHeight] = useState(() => (
    typeof window === 'undefined' ? 0 : Math.round(window.visualViewport?.height || window.innerHeight)
  ));
  const [queuedPanelDialog, setQueuedPanelDialog] = useState(null);
  const reopenContextAfterDialog = useRef(false);
  const [panelDialog, setPanelDialog] = useState(null);
  const [recommendationFeedback, setRecommendationFeedback] = useState({});
  const [answerFeedback, setAnswerFeedback] = useState({});
  const [attachmentNotice, setAttachmentNotice] = useState('');
  const [pendingMessageJump, setPendingMessageJump] = useState(null);
  const [autoFollowSpacer, setAutoFollowSpacer] = useState(0);
  const [autoFollowRevision, setAutoFollowRevision] = useState(0);
  const pendingAutoFollow = useRef(null);
  const chatRoot = useRef(null);
  const contextPanel = useRef(null);
  const contextClose = useRef(null);
  const contextTrigger = useRef(null);
  const composerForm = useRef(null);
  const previousContextInline = useRef(false);
  const contextHadFocus = useRef(false);
  const focusComposerAfterPanelDialog = useRef(false);
  const panelDialogTrigger = useRef(null);
  const chatFeed = useRef(null);
  const chatMenu = useRef(null);

  const questionInput = useRef(null);
  const fileInput = useRef(null);
  const pendingCaret = useRef(null);
  const chatId = session.selectedChatId;
  const currentChat = session.chats.find(chat => chat.id === chatId) || null;
  const messages = chatId ? (session.messagesByChat[chatId] || []) : [];
  const progress = chatId ? (session.progressByChat[chatId] || []) : [];
  const pendingMessage = findPendingAnswer(messages);
  const answerPending = Boolean(chatId && (session.pendingChats[chatId] || session.activeAskChatId === chatId) && pendingMessage);
  const unansweredQuestion = messages.at(-1)?.role === 'user' && !messages.at(-1)?.localPending;
  const pinnedFileIds = Array.isArray(currentChat?.pinned) ? currentChat.pinned : [];
  const readyFiles = useMemo(() => session.files.filter(file => file.status === 'ready'), [session.files]);
  const mentionLimitReached = session.mentions.length >= 10;
  const suggestions = useMemo(() => {
    if (!mentionQuery || mentionLimitReached) return [];
    const query = mentionQuery.query.toLocaleLowerCase();
    return readyFiles
      .filter(file => file.name.toLocaleLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionLimitReached, mentionQuery, readyFiles]);
  const composerNote = mentionQuery && suggestions.length === 0
    ? mentionLimitReached
      ? 'You can mention up to 10 files in one question.'
      : `No ready project files match “${mentionQuery.query}”.`
    : '';
  const question = session.draft.trim();
  const questionTooLong = Boolean(question) && exceedsQuestionLimit(question);
  const keyboardModifier = typeof navigator !== 'undefined'
    && /Mac|iPhone|iPad|iPod|iOS/.test(navigator.userAgentData?.platform || navigator.platform || '')
    ? '⌘'
    : 'Ctrl';
  const keyboardModifierLabel = keyboardModifier === '⌘' ? 'Command' : 'Control';
  const hasPendingFiles = session.files.some(file => file.status === 'pending');
  const canInlineContext = expanded
    && viewportWidth >= AUTO_CONTEXT_VIEWPORT_WIDTH
    && contextAreaWidth >= CONTEXT_PANEL_WIDTH + MIN_MAIN_WIDTH;
  const contextVisible = contextPreference === null ? canInlineContext : contextPreference;
  const contextInlineOpen = canInlineContext && contextVisible;
  const contextOverlayOpen = contextVisible && !canInlineContext;

  useLayoutEffect(() => {
    const root = chatRoot.current;
    if (!root) return undefined;
    const updateSize = () => {
      const width = Math.round(root.getBoundingClientRect().width);
      const height = Math.round(root.getBoundingClientRect().height);
      const nextViewportWidth = window.innerWidth;
      const nextViewportHeight = Math.round(window.visualViewport?.height || window.innerHeight);
      const headerHeight = Number.parseFloat(window.getComputedStyle(root).getPropertyValue('--header-height')) || 0;
      const availableHeight = Math.max(0, Math.min(height, nextViewportHeight - headerHeight));
      root.style.setProperty(
        '--rag-chat-composer-max-height',
        `${availableHeight / 2}px`,
      );
      setContextAreaWidth(previous => (previous === width ? previous : width));
      setChatAreaHeight(previous => (previous === height ? previous : height));
      setViewportWidth(previous => (previous === nextViewportWidth ? previous : nextViewportWidth));
      setViewportHeight(previous => (previous === nextViewportHeight ? previous : nextViewportHeight));
    };
    updateSize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateSize) : null;
    observer?.observe(root);
    window.addEventListener('resize', updateSize);
    window.visualViewport?.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
      window.visualViewport?.removeEventListener('resize', updateSize);
    };
  }, []);

  useDialogFocus({
    active: contextOverlayOpen && !panelDialog && !queuedPanelDialog,
    dialogRef: contextPanel,
    onClose: () => setContextPreference(false),
    initialFocusRef: contextClose,
  });

  useEffect(() => {
    function trackContextFocus(event) {
      if (event.target === document.body || event.target === document.documentElement) return;
      contextHadFocus.current = contextPanel.current?.contains(event.target) || false;
    }
    document.addEventListener('focusin', trackContextFocus, true);
    return () => document.removeEventListener('focusin', trackContextFocus, true);
  }, []);

  useLayoutEffect(() => {
    if (previousContextInline.current && !contextInlineOpen) {
      setContextPreference(false);
      if (contextHadFocus.current) contextTrigger.current?.focus({ preventScroll: true });
    }
    previousContextInline.current = contextInlineOpen;
  }, [contextInlineOpen]);

  useEffect(() => {
    if (!queuedPanelDialog || contextOverlayOpen) return;
    setPanelDialog(queuedPanelDialog);
    setQueuedPanelDialog(null);
  }, [contextOverlayOpen, queuedPanelDialog]);

  useEffect(() => {
    if (panelDialog || queuedPanelDialog) return;
    const returnTarget = panelDialogTrigger.current;
    panelDialogTrigger.current = null;
    if (focusComposerAfterPanelDialog.current) {
      focusComposerAfterPanelDialog.current = false;
      questionInput.current?.focus({ preventScroll: true });
    } else if (returnTarget?.isConnected && returnTarget.getClientRects().length
      && !returnTarget.closest('[inert]') && getComputedStyle(returnTarget).visibility !== 'hidden') {
      returnTarget.focus({ preventScroll: true });
    }
  }, [contextVisible, panelDialog, queuedPanelDialog]);

  useLayoutEffect(() => {
    const textarea = questionInput.current;
    const composer = composerForm.current;
    const root = chatRoot.current;
    if (!textarea || !composer || !root) return;
    const currentFieldHeight = textarea.getBoundingClientRect().height;
    const chromeHeight = Math.max(0, composer.scrollHeight - currentFieldHeight
      + composer.offsetHeight - composer.clientHeight);
    const headerHeight = Number.parseFloat(window.getComputedStyle(root).getPropertyValue('--header-height')) || 0;
    const availableHeight = Math.max(
      0,
      Math.min(chatAreaHeight || root.clientHeight || viewportHeight, viewportHeight - headerHeight),
    );
    const maxHeight = Math.max(44, Math.floor(availableHeight * 0.5 - chromeHeight));
    textarea.style.maxHeight = `${maxHeight}px`;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${Math.max(44, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [chatAreaHeight, contextAreaWidth, session.draft, session.mentions.length, viewportHeight, viewportWidth]);

  function submitQuestionAndFollow(questionText, submit) {
    const content = typeof questionText === 'string' ? questionText.trim() : '';
    const canTrack = Boolean(
      session.authenticated
      && chatId
      && content
      && session.activeAskChatId === null
      && !session.pendingChats[chatId]
      && session.mentions.length <= 10
    );
    if (!canTrack) {
      submit();
      return;
    }

    const previousRequestIds = new Set(messages.map(message => message.request_id).filter(Boolean));
    const follow = {
      chatId,
      projectId: session.selectedProjectId,
      loginName: session.loginName,
      requestId: null,
      phase: 'pending',
      cancelled: false,
    };
    pendingAutoFollow.current = follow;
    setAutoFollowSpacer(0);
    submit();

    const submittedMessages = getRagChatSession().messagesByChat[chatId] || [];
    for (let index = submittedMessages.length - 1; index >= 0; index -= 1) {
      const message = submittedMessages[index];
      if (message.role === 'user' && message.localPending && message.content === content && message.request_id && !previousRequestIds.has(message.request_id)) {
        follow.requestId = message.request_id;
        break;
      }
    }
    if (follow.requestId) setAutoFollowRevision(revision => revision + 1);
    else if (pendingAutoFollow.current === follow) pendingAutoFollow.current = null;
  }

  function cancelPendingAutoFollow() {
    const follow = pendingAutoFollow.current;
    if (!follow || follow.phase !== 'pending') return;
    follow.cancelled = true;
    pendingAutoFollow.current = null;
  }

  function handleFeedPointerDown(event) {
    const feed = chatFeed.current;
    if (!feed || !pendingAutoFollow.current || pendingAutoFollow.current.phase !== 'pending') return;
    const rect = feed.getBoundingClientRect();
    const onVerticalScrollbar = event.clientX >= rect.left + feed.clientWidth || event.clientX >= rect.right - 14;
    const onHorizontalScrollbar = event.clientY >= rect.top + feed.clientHeight || event.clientY >= rect.bottom - 14;
    if (onVerticalScrollbar || onHorizontalScrollbar) cancelPendingAutoFollow();
  }

  function handleFeedKeyDown(event) {
    const isScrollKey = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Spacebar'].includes(event.key);
    if (!isScrollKey) return;
    if ((event.key === ' ' || event.code === 'Space') && event.target.closest?.('button, a, input, textarea, select, [contenteditable="true"]')) return;
    cancelPendingAutoFollow();
  }

  useEffect(() => {
    if (session.authenticated) return;
    setPanelDialog(null);
    setQueuedPanelDialog(null);
    reopenContextAfterDialog.current = false;
    setAttachmentNotice('');
    setAnswerFeedback({});
    setRecommendationFeedback({});
    setPendingMessageJump(null);
  }, [session.authenticated]);

  useEffect(() => {
    pendingAutoFollow.current = null;
    setAutoFollowSpacer(0);
  }, [chatId, session.selectedProjectId, session.authenticated, session.loginName]);

  useEffect(() => {
    const follow = pendingAutoFollow.current;
    const feed = chatFeed.current;
    if (!follow || !feed || follow.cancelled || !follow.requestId) return undefined;
    if (
      follow.chatId !== chatId
      || follow.projectId !== session.selectedProjectId
      || follow.loginName !== session.loginName
      || !session.authenticated
    ) return undefined;

    const answer = messages.find(message => message.role === 'assistant' && message.request_id === follow.requestId && message.status !== 'error');
    if (answer) {
      follow.phase = 'answer';
      const frame = requestAnimationFrame(() => {
        if (pendingAutoFollow.current !== follow || follow.cancelled) return;
        const targetId = answer.id || answer.request_id;
        const target = document.getElementById(`rag-chat-message-${targetId}`);
        if (!target) return;
        const feedRect = feed.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const answerTop = feed.scrollTop + targetRect.top - feedRect.top - feed.clientTop;
        const desiredScrollTop = Math.max(0, answerTop - feed.clientHeight * 0.25);
        const unspacedMaxScrollTop = feed.scrollHeight - autoFollowSpacer - feed.clientHeight;
        const neededSpacer = Math.ceil(Math.max(0, desiredScrollTop - unspacedMaxScrollTop));
        if (neededSpacer !== autoFollowSpacer) {
          setAutoFollowSpacer(neededSpacer);
          return;
        }
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        feed.scrollTo({ top: desiredScrollTop, behavior: reducedMotion ? 'auto' : 'smooth' });
        pendingAutoFollow.current = null;
      });
      return () => cancelAnimationFrame(frame);
    }

    if (!answerPending) {
      pendingAutoFollow.current = null;
      setAutoFollowSpacer(0);
      return undefined;
    }

    const question = messages.find(message => message.role === 'user' && message.request_id === follow.requestId);
    if (!question) return undefined;
    const frame = requestAnimationFrame(() => {
      if (pendingAutoFollow.current !== follow || follow.cancelled) return;
      feed.scrollTop = feed.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [
    answerPending,
    autoFollowSpacer,
    chatId,
    messages,
    progress,
    session.authenticated,
    session.loginName,
    session.selectedProjectId,
    autoFollowRevision,
  ]);


  useEffect(() => {
    if (!session.authenticated || !session.selectedProjectId || !hasPendingFiles) return undefined;
    const projectId = session.selectedProjectId;
    const timer = setInterval(() => void refreshSessionFiles(projectId), 4_000);
    return () => clearInterval(timer);
  }, [session.authenticated, session.selectedProjectId, hasPendingFiles]);

  useEffect(() => {
    if (pendingCaret.current === null || !questionInput.current) return;
    const position = pendingCaret.current;
    pendingCaret.current = null;
    questionInput.current.focus();
    questionInput.current.setSelectionRange(position, position);
  }, [session.draft]);
  useEffect(() => {
    function handleMessageJump(event) {
      const target = event.detail;
      if (!target || target.projectId !== session.selectedProjectId) return;
      pendingAutoFollow.current = null;
      if (!expanded) onToggleExpanded?.();
      setPendingMessageJump(target);
    }
    window.addEventListener('rag-chat:jump-to-message', handleMessageJump);
    return () => window.removeEventListener('rag-chat:jump-to-message', handleMessageJump);
  }, [expanded, onToggleExpanded, session.selectedProjectId]);

  useEffect(() => {
    if (!pendingMessageJump || pendingMessageJump.chatId !== chatId) return undefined;
    const answer = messages.find(message => message.id === pendingMessageJump.messageId);
    if (!answer) return undefined;
    const targetId = answer.id || answer.request_id;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`rag-chat-message-${targetId}`);
      if (!target) return;
      target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      target.focus({ preventScroll: true });
      setPendingMessageJump(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingMessageJump, chatId, messages]);


  function handleSubmit(event) {
    event.preventDefault();
    if (!questionTooLong) {
      const canSubmit = Boolean(question && chatId && !answerPending && session.activeAskChatId === null && !session.pendingChats[chatId]);
      submitQuestionAndFollow(session.draft, () => submitSessionQuestion(session.draft));
      if (canSubmit) setAttachmentNotice('');
    }
    setMentionQuery(null);
  }

  function updateMentionQuery(text, caret) {
    setMentionQuery(getMentionQuery(text, caret));
    setActiveSuggestion(0);
  }

  function chooseMention(file) {
    if (!mentionQuery || !addSessionMention(file)) return;
    const caret = mentionQuery.start;
    const nextDraft = replaceMentionQuery(session.draft, mentionQuery);
    pendingCaret.current = caret;
    setSessionDraft(nextDraft);
    setMentionQuery(null);
  }

  function handleQuestionKeyDown(event) {
    if (mentionQuery && suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveSuggestion(index => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveSuggestion(index => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        chooseMention(suggestions[activeSuggestion]);
        return;
      }
      if (event.key === 'Escape') {
        setMentionQuery(null);
        return;
      }
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      event.currentTarget.form.requestSubmit();
    }
  }

  async function createLinkedAiProject() {
    if (!localProject.context || creatingAiProject) return;
    const localProjectId = workspace.activeProjectId;
    setCreatingAiProject(true);
    try {
      const serverProjectId = await createAiProject(localProject.context);
      if (serverProjectId) workspace.linkServerProject(localProjectId, serverProjectId);
    } finally {
      setCreatingAiProject(false);
    }
  }

  function importLocalProject() {
    if (!localProject.context) return;
    const name = localProject.context.name;
    const existing = session.projects.find(project => project.name === name);
    if (existing) {
      const shouldUpdate = window.confirm(`Replace the brief in server project “${existing.name}” with the brief from local workspace “${name}”? The two projects are separate despite sharing a name. Existing server chats and files will remain.`);
      if (shouldUpdate) {
        void updateSessionProject(existing.id, { brief_text: localProject.context.text })
          .then(result => { if (result) void selectSessionProject(existing.id); });
      }
      return;
    }
    if (window.confirm(`Create a new server project named “${name}” using the brief from local workspace “${name}”? This copies the brief to the server and does not change the local project.`)) {
      void createSessionProject(name, localProject.context.text);
    }
  }
  function openPanelDialog(dialog) {
    panelDialogTrigger.current = document.activeElement;
    focusComposerAfterPanelDialog.current = false;
    if (contextOverlayOpen) {
      reopenContextAfterDialog.current = true;
      setContextPreference(false);
      setQueuedPanelDialog(dialog);
      return;
    }
    setPanelDialog(dialog);
  }

  function closePanelDialog() {
    setPanelDialog(null);
    if (reopenContextAfterDialog.current) {
      reopenContextAfterDialog.current = false;
      if (!focusComposerAfterPanelDialog.current) setContextPreference(true);
    }
  }

  function handleContextTabKeyDown(event) {
    const views = ['project', 'files', 'tasks'];
    const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!direction && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const currentIndex = views.indexOf(contextView);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? views.length - 1
        : (currentIndex + direction + views.length) % views.length;
    const nextView = views[nextIndex];
    setContextView(nextView);
    event.currentTarget.parentElement?.querySelector(`[data-context-tab="${nextView}"]`)?.focus();
  }

  function removeNextQuestionMention(file) {
    removeSessionMention(file.id);
    setAttachmentNotice(`${file.name} removed from the next question.`);
  }

  function showContextView(view) {
    setContextView(view);
    setContextPreference(true);
  }

  function openFileBrowser() {
    if (!serverProject || !session.selectedProjectId) return;
    openPanelDialog({ type: 'file', projectId: session.selectedProjectId, project: serverProject });
  }

  function startNewChat() {
    void createSessionChat();
  }


  function renameChat(chat) {
    const title = window.prompt('Rename this chat', chat.title);
    if (title?.trim()) void renameSessionChat(chat.id, title.trim());
  }

  function removeChat(chat) {
    if (window.confirm(`Delete “${chat.title}” and its messages? This cannot be undone.`)) void deleteSessionChat(chat.id);
  }

  function removeFile(file) {
    if (window.confirm(`Delete “${file.name}” from this project? It will also be unpinned from chats.`)) void deleteSessionFile(file.id);
  }

  async function uploadFile(file) {
    if (!file) return;
    if (!classifyFileExtension(file.name)) {
      setUploadError('Unsupported file type. See the list of supported formats.');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      setUploadError('New uploads must be 10 MiB or smaller.');
      if (fileInput.current) fileInput.current.value = '';
      return;
    }
    const mime = typeof file.type === 'string' && file.type.length <= 100 ? file.type : '';
    setUploadError('');
    setUploading(true);
    await uploadSessionFile(file, mime);
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  function openAnswerDialog(type, message) {
    if (!serverProject || !session.selectedProjectId) return;
    openPanelDialog({ type, projectId: session.selectedProjectId, project: serverProject, message });
  }

  async function addRecommendationTodo(message, text, index) {
    const projectId = session.selectedProjectId;
    const messageId = message.id;
    if (!projectId || !messageId) return;
    setRecommendationFeedback(previous => ({
      ...previous,
      [messageId]: { ...(previous[messageId] || {}), [index]: 'Adding…' },
    }));
    try {
      const todo = await createSessionTodo(projectId, text, messageId);
      setRecommendationFeedback(previous => ({
        ...previous,
        [messageId]: { ...(previous[messageId] || {}), [index]: todo ? 'Added to tasks' : 'Could not save' },
      }));
    } catch {
      setRecommendationFeedback(previous => ({
        ...previous,
        [messageId]: { ...(previous[messageId] || {}), [index]: 'Could not save · retry' },
      }));
    }
  }

  async function saveTodoFromAnswer(text, sourceMessageId) {
    const todo = await createSessionTodo(panelDialog.projectId, text, sourceMessageId);
    if (todo) {
      setAnswerFeedback(previous => ({ ...previous, [sourceMessageId]: 'Task saved to server project tasks.' }));
    }
    return todo;
  }

  async function saveBriefFromAnswer(field, text, expectedText, sourceMessageId) {
    const project = await saveSessionProjectBrief(panelDialog.projectId, field, text, expectedText, sourceMessageId);
    if (project) {
      setAnswerFeedback(previous => ({ ...previous, [sourceMessageId]: 'Server project brief updated.' }));
    }
    return project;
  }

  function reportAttachedFile(file) {
    focusComposerAfterPanelDialog.current = true;
    const notice = `${file.name} is ready for the next question; the earlier answer is unchanged.`;
    if (panelDialog?.message?.id) {
      setAnswerFeedback(previous => ({
        ...previous,
        [panelDialog.message.id]: notice,
      }));
    } else {
      setAttachmentNotice(`${file.name} is ready for the next question.`);
    }
  }

  function renderAnswer(message) {
    const precedingQuestion = messages.find(item => item.role === 'user' && item.request_id === message.request_id)?.content || '';
    const answer = normalizedAnswer(message);
    const busy = answerPending || session.activeAskChatId !== null;
    return (
      <AnswerContent
        answer={answer}
        busy={busy}
        actionFeedback={answerFeedback[message.id] || ''}
        recommendationFeedback={recommendationFeedback[message.id] || {}}
        onFollowUp={followUp => submitQuestionAndFollow(followUp, () => submitSessionQuestion(followUp))}
        onAskAsTechnical={() => submitQuestionAndFollow(precedingQuestion, () => askMessageAsTechnical(precedingQuestion))}
        onAddToTodo={() => openAnswerDialog('todo', message)}
        onSaveBrief={() => openAnswerDialog('brief', message)}
        onAttachFile={() => openAnswerDialog('file', message)}
        onAddRecommendation={(text, index) => void addRecommendationTodo(message, text, index)}
      />
    );
  }

  return (
    <section
      ref={chatRoot}
      className={`rag-chat-page${expanded ? ' is-expanded' : ' is-compact'}`}
      aria-label="AI Cofounder"
      style={{ '--rag-chat-viewport-height': `${viewportHeight}px` }}
    >
      {session.error && (
        <div className="rag-chat-global-error" role="alert">
          <span>{session.error}</span>
          <button className="rag-chat-icon-button" type="button" onClick={clearSessionError}>Dismiss</button>
        </div>
      )}
      <div className="rag-chat-layout" data-context-inline={contextInlineOpen ? 'true' : undefined}>


        {contextOverlayOpen && (
          <div
            className="rag-chat-context-scrim"
            data-dialog-backdrop
            aria-hidden="true"
            onMouseDown={event => {
              if (event.target === event.currentTarget) setContextPreference(false);
            }}
          />
        )}
        <aside
          className={`rag-chat-context${contextInlineOpen ? ' is-inline' : ' is-overlay'}`}
          id="rag-chat-context"
          ref={contextPanel}
          hidden={!contextVisible}
          role={contextOverlayOpen ? 'dialog' : undefined}
          aria-modal={contextOverlayOpen && !panelDialog ? 'true' : undefined}
          aria-labelledby="rag-chat-context-title"
          tabIndex={contextOverlayOpen ? -1 : undefined}
          data-overlay={contextOverlayOpen ? 'true' : undefined}
        >
          <header className="rag-chat-context__header">
            <h2 id="rag-chat-context-title">Context</h2>
            <button
              ref={contextClose}
              className="rag-chat-icon-button"
              type="button"
              onClick={() => setContextPreference(false)}
              aria-label="Hide context"
              title="Hide context"
            >
              <X size={17} aria-hidden="true" />
            </button>
          </header>
          <div className="rag-chat-context__tabs" role="tablist" aria-label="Project context">
            {[
              ['project', 'Project', FileText],
              ['files', 'Files', FilePlus2],
              ['tasks', 'Tasks', ClipboardList],
            ].map(([view, label, Icon]) => (
              <button
                className="rag-chat-context__tab"
                type="button"
                role="tab"
                id={`rag-chat-context-tab-${view}`}
                data-context-tab={view}
                aria-selected={contextView === view}
                aria-controls={`rag-chat-context-panel-${view}`}
                tabIndex={contextView === view ? 0 : -1}
                key={view}
                onClick={() => setContextView(view)}
                onKeyDown={handleContextTabKeyDown}
              >
                <Icon size={16} aria-hidden="true" />{label}
              </button>
            ))}
          </div>
          <div className="rag-chat-context__content">
            <section
              className="rag-chat-context__view"
              id="rag-chat-context-panel-project"
              role="tabpanel"
              aria-labelledby="rag-chat-context-tab-project"
              tabIndex={0}
              hidden={contextView !== 'project'}
            >
              {serverProject ? (
                <div className="server-project-overview">
                  <div className="server-project-overview__identity">
                    <span className="rag-chat-label">Server project</span>
                    <h3>{serverProject.name}</h3>
                  </div>
                  <section className="server-project-overview__brief" aria-label="Server project brief">
                    <h3>Brief · {hasServerBrief ? 'Saved' : 'Not set'}</h3>
                    {hasServerBrief ? (
                      <dl>
                        {serverBriefValues.filter(([, , value]) => value.trim()).map(([field, label, value]) => (
                          <div key={field}>
                            <dt>{label}</dt>
                            <dd>{value}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p>No brief has been saved for this project.</p>
                    )}
                  </section>
                </div>
              ) : (
                <p className="rag-chat-help">Choose a server project in the AI header to see its context.</p>
              )}
              <div className="rag-chat-context__import">
                <button className="button ghost" type="button" onClick={importLocalProject} disabled={!localProject.context}>
                  <Upload size={15} aria-hidden="true" />Import local brief
                </button>
                {!localProject.context && <p className="rag-chat-help">Choose a local workspace project to import its brief.</p>}
                {localProject.truncated && <p className="rag-chat-help">The imported brief is bounded to 8 KiB.</p>}
              </div>
            </section>

            <section
              className="rag-chat-context__view"
              id="rag-chat-context-panel-files"
              role="tabpanel"
              aria-labelledby="rag-chat-context-tab-files"
              tabIndex={0}
              hidden={contextView !== 'files'}
            >
              <div className="rag-chat-context__section-head">
                <h3>Project files</h3>
                <div className="rag-chat-context__upload">
                  <button className="button secondary" type="button" onClick={openFileBrowser} disabled={!serverProject} aria-label="Browse and import project files">
                    <FilePlus2 size={15} aria-hidden="true" />Browse
                  </button>
                  <button className="button secondary" type="button" onClick={() => fileInput.current?.click()} disabled={!serverProject || uploading} aria-label="Upload a project file" aria-describedby="rag-chat-upload-limit">
                    <Upload size={15} aria-hidden="true" />{uploading ? 'Uploading…' : 'Upload'}
                  </button>
                  <input
                    ref={fileInput}
                    className="rag-chat-file-input"
                    type="file"
                    accept={FILE_INPUT_ACCEPT}
                    disabled={!serverProject || uploading}
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={event => void uploadFile(event.target.files?.[0])}
                  />
                </div>
              </div>
              <details className="rag-chat-supported-formats">
                <summary>Supported formats</summary>
                <ul className="rag-chat-supported-formats__list">
                  {SUPPORTED_FILE_FORMAT_GROUPS.map(group => (
                    <li key={group.kind}>
                      <strong>{group.label}</strong>
                      <span>{group.extensions.map(extension => `.${extension}`).join(', ')}</span>
                    </li>
                  ))}
                </ul>
              </details>
              <p id="rag-chat-upload-limit" className="rag-chat-help">New uploads up to 10 MiB.</p>
              {uploadError && <p className="rag-chat-upload-error" role="alert">{uploadError}</p>}
              {session.uploads.filter(upload => upload.projectId === session.selectedProjectId).map(upload => {
                const percent = upload.total ? Math.round((upload.loaded / upload.total) * 100) : 100;
                return (
                  <div className={`rag-chat-upload-progress${upload.status === 'error' ? ' has-error' : ''}`} key={upload.id}>
                    <div><span>{upload.name}</span><span>{upload.status === 'error' ? 'Failed' : `${percent}%`}</span></div>
                    <progress max={upload.total || 1} value={upload.loaded} aria-label={`Upload progress for ${upload.name}`} />
                    {upload.error && <p role="alert">{upload.error}</p>}
                  </div>
                );
              })}
              <section className="rag-chat-context__mentions" aria-label="Files for the next question">
                <h3>Next question</h3>
                {session.mentions.length === 0 ? (
                  <p className="rag-chat-help">No files selected. Use @ in the composer to add one.</p>
                ) : (
                  <ul className="rag-chat-context__mention-list">
                    {session.mentions.map(mention => (
                      <li key={mention.id}>
                        <span>@{mention.name}</span>
                        <button className="rag-chat-icon-button" type="button" onClick={() => removeNextQuestionMention(mention)} aria-label={`Remove ${mention.name} mention`}>
                          <X size={16} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              {session.files.length === 0 ? (
                <p className="rag-chat-help">No files in this project.</p>
              ) : (
                <ul className="rag-chat-file-list">
                  {session.files.map(file => {
                    const pinned = pinnedFileIds.includes(file.id);
                    const canPin = Boolean(chatId) && (file.status !== 'failed' || pinned);
                    return (
                      <li className="rag-chat-file-item" key={file.id}>
                        <div className="rag-chat-file-item__main">
                          <span className="rag-chat-file-item__name" title={file.name}>{file.name}</span>
                          <small>{formatFileSize(file.size_bytes)} · {fileKindLabel(file)} · {fileStatusHint(file)}</small>
                          <small>{pinned ? 'Pinned to this chat' : 'Not pinned to this chat'}</small>
                        </div>
                        <div className="rag-chat-file-item__actions">
                          {chatId && (
                            <button
                              className={`rag-chat-icon-button${pinned ? ' is-selected' : ''}`}
                              type="button"
                              onClick={() => void toggleSessionFilePin(chatId, file.id)}
                              disabled={!canPin}
                              aria-label={`${pinned ? 'Unpin' : 'Pin'} ${file.name} ${pinned ? 'from' : 'to'} this chat`}
                              title={pinned ? 'Unpin from this chat' : 'Pin to this chat'}
                            >
                              {pinned ? <PinOff size={15} aria-hidden="true" /> : <Pin size={15} aria-hidden="true" />}
                            </button>
                          )}
                          <button className="rag-chat-icon-button rag-chat-icon-button--danger" type="button" onClick={() => removeFile(file)} aria-label={`Delete ${file.name}`} title="Delete file">
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section
              className="rag-chat-context__view"
              id="rag-chat-context-panel-tasks"
              role="tabpanel"
              aria-labelledby="rag-chat-context-tab-tasks"
              tabIndex={0}
              hidden={contextView !== 'tasks'}
            >
              <ProjectTodos projectId={session.selectedProjectId} compact />
            </section>
          </div>
        </aside>

            <section className="rag-chat-conversation" aria-label="Project conversation">
              <header className="rag-chat-conversation__header">
                <div className="rag-chat-project-picker">
                  <label className="sr-only" htmlFor="rag-chat-project-select">Server project</label>
                  <select
                    id="rag-chat-project-select"
                    value={session.selectedProjectId || ''}
                    onChange={event => void selectSessionProject(event.target.value || null)}
                    aria-label="Server project"
                  >
                    <option value="">Choose a project</option>
                    {session.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}
                  </select>
                  <button
                    className="rag-chat-icon-button rag-chat-header__new-project"
                    type="button"
                    onClick={() => workspace.go('/new-project')}
                    aria-label="Create a new project"
                    title="New project"
                  >
                    <FilePlus2 size={16} aria-hidden="true" /><span>New project</span>
                  </button>
                </div>
                <details className="rag-chat-title-menu" ref={chatMenu}>
                  <summary title="Select or manage chats">
                    <h2>{currentChat?.title || 'No chat selected'}</h2>
                    <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div className="rag-chat-title-menu__content">
                    <span className="rag-chat-title-menu__label">Choose a chat</span>
                    {session.chats.length === 0 ? (
                      <p className="rag-chat-help">No chats yet.</p>
                    ) : (
                      <ul>
                        {session.chats.map(chat => (
                          <li key={chat.id} className="rag-chat-title-menu__chat-row">
                            <button
                              className="rag-chat-title-menu__chat-select"
                              type="button"
                              aria-current={chat.id === chatId ? 'page' : undefined}
                              onClick={() => {
                                void selectSessionChat(chat.id);
                                if (chatMenu.current) chatMenu.current.open = false;
                              }}
                            >{chat.title}</button>
                            <button
                              className="rag-chat-title-menu__chat-action"
                              type="button"
                              aria-label={`Rename chat: ${chat.title}`}
                              title={`Rename ${chat.title}`}
                              onClick={() => {
                                renameChat(chat);
                                if (chatMenu.current) chatMenu.current.open = false;
                              }}
                            >Rename</button>
                            <button
                              className="rag-chat-title-menu__chat-action"
                              type="button"
                              aria-label={`Delete chat: ${chat.title}`}
                              title={`Delete ${chat.title}`}
                              disabled={session.pendingChats[chat.id] || session.activeAskChatId === chat.id}
                              onClick={() => {
                                removeChat(chat);
                                if (chatMenu.current) chatMenu.current.open = false;
                              }}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="rag-chat-title-menu__actions">
                      <button type="button" onClick={() => { startNewChat(); if (chatMenu.current) chatMenu.current.open = false; }} disabled={!session.selectedProjectId}>
                        <MessageSquarePlus size={14} aria-hidden="true" />New chat
                      </button>
                    </div>
                  </div>
                </details>
                <button
                  ref={contextTrigger}
                  className="rag-chat-context-toggle"
                  type="button"
                  aria-expanded={contextVisible}
                  aria-controls="rag-chat-context"
                  aria-label={`${contextVisible ? 'Hide' : 'Show'} project context`}
                  title={`${contextVisible ? 'Hide' : 'Show'} context`}
                  onClick={() => setContextPreference(!contextVisible)}
                >
                  {contextVisible ? <PanelRightClose size={17} aria-hidden="true" /> : <PanelRightOpen size={17} aria-hidden="true" />}
                  <span>Context</span>
                </button>
              </header>

              {!session.selectedProjectId ? (
                <div className="rag-chat-empty">
                  {linkedServerProject ? <>
                    <p>AI Cofounder for this project is ready.</p>
                    <button className="button primary" type="button" onClick={() => void selectSessionProject(linkedServerProject.id)}>Open “{linkedServerProject.name}”</button>
                  </> : localProject.context ? <>
                    <p>Start AI Cofounder for this project. It uses the project brief as context.</p>
                    <button className="button primary" type="button" onClick={() => void createLinkedAiProject()} disabled={creatingAiProject} aria-busy={creatingAiProject}>
                      <FilePlus2 size={15} aria-hidden="true" />{creatingAiProject ? 'Creating AI project…' : `Create AI project for “${localProject.context.name}”`}
                    </button>
                  </> : <>
                    <p>Create a project to start a conversation.</p>
                    <button className="button primary" type="button" onClick={() => workspace.go('/new-project')}><FilePlus2 size={15} aria-hidden="true" />Create a project</button>
                  </>}
                </div>
              ) : !currentChat ? (
                <div className="rag-chat-empty">
                  <p>This project has no open chat.</p>
                  <button className="button primary" type="button" onClick={startNewChat}><MessageSquarePlus size={15} aria-hidden="true" />New chat</button>
                </div>
              ) : (
                <>
                  <div className="rag-chat-feed" ref={chatFeed} role="log" tabIndex={0} aria-label="Project chat conversation" aria-live="polite" aria-relevant="additions text" aria-busy={answerPending} onWheel={cancelPendingAutoFollow} onTouchStart={cancelPendingAutoFollow} onPointerDown={handleFeedPointerDown} onKeyDown={handleFeedKeyDown}>
                    {messages.length === 0 && (
                      <div className="rag-chat-empty">
                        <p>Ask about a project decision or a detail in one of its ready files.</p>
                      </div>
                    )}
                    {messages.map((message, index) => (
                      <article
                        className="rag-chat-turn"
                        id={`rag-chat-message-${message.id || message.request_id || index}`}
                        tabIndex={-1}
                        key={message.id || message.request_id || index}
                      >
                        {message.role === 'user' ? (
                          <div className="rag-chat-user">
                            <span className="rag-chat-label">You</span>
                            <p>{message.content}</p>
                            {message.mentions?.length > 0 && (
                              <ul className="rag-chat-mention-chips" aria-label="Mentioned files">
                                {message.mentions.map(fileId => {
                                  const file = session.files.find(item => item.id === fileId);
                                  return <li key={fileId}>{file?.name || 'Project file'}</li>;
                                })}
                              </ul>
                            )}
                          </div>
                        ) : message.status === 'error' ? (
                          <div className="rag-chat-error" role="alert">
                            <p>{message.content}</p>
                            <button className="button secondary" type="button" onClick={() => {
                              const original = messages.find(item => item.role === 'user' && item.request_id === message.request_id);
                              if (original) submitQuestionAndFollow(original.content, () => submitSessionQuestion(original.content));
                            }} disabled={answerPending}>
                              <Send size={15} aria-hidden="true" />Ask again
                            </button>
                          </div>
                        ) : (
                          renderAnswer(message)
                        )}
                        {message === pendingMessage && answerPending && <RequestProgress events={progress} />}
                      </article>
                    ))}
                    {session.requestErrors[chatId] && (
                      <p className="rag-chat-pending-note" role="status">
                        {session.requestErrors[chatId]}
                        {unansweredQuestion && (answerPending
                          ? ' Checking this chat’s saved history for the answer; nothing is resent.'
                          : ' Reopen this chat later to check its saved history.')}
                      </p>
                    )}
                    {autoFollowSpacer > 0 && <div className="rag-chat-feed__autoscroll-space" aria-hidden="true" style={{ height: autoFollowSpacer, flex: '0 0 auto' }} />}
                  </div>

                  <form ref={composerForm} className="rag-chat-composer" onSubmit={handleSubmit}>
                    {attachmentNotice && <p className="sr-only" role="status">{attachmentNotice}</p>}
                    <div className="rag-chat-context-line" role="group" aria-label="Current question context">
                      <span><strong>Project</strong> {serverProject?.name || 'No project'}</span>
                      <span><strong>Brief</strong> {hasServerBrief ? 'saved' : 'not set'}</span>
                      <span>{session.technicalQuestion ? 'Technical' : 'Auto'}</span>
                      {session.mentions.length > 0 && (
                        <button
                          className="rag-chat-context-line__files"
                          type="button"
                          onClick={() => showContextView('files')}
                          aria-label={`View ${session.mentions.length} file${session.mentions.length === 1 ? '' : 's'} selected for the next question`}
                        >
                          <FileText size={14} aria-hidden="true" />
                          <span>{session.mentions[0].name}</span>
                          <small>{session.mentions.length > 1 ? `+${session.mentions.length - 1} files` : 'Files'}</small>
                        </button>
                      )}
                    </div>
                    <label className="sr-only" htmlFor="rag-chat-question">Ask a question</label>
                    {session.mentions.length > 0 && (
                      <ul className="rag-chat-mention-chips" aria-label="Files to mention">
                        {session.mentions.map(mention => (
                          <li key={mention.id}>
                            <span>@{mention.name}</span>
                            <button type="button" onClick={() => removeSessionMention(mention.id)} aria-label={`Remove ${mention.name} mention`}>×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="rag-chat-composer__input-wrap">
                      <textarea
                        name="question"
                        autoComplete="off"
                        id="rag-chat-question"
                        ref={questionInput}
                        value={session.draft}
                        onChange={event => {
                          setSessionDraft(event.target.value);
                          updateMentionQuery(event.target.value, event.target.selectionStart);
                        }}
                        onClick={event => updateMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart)}
                        onKeyUp={event => {
                          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Control', 'Meta'].includes(event.key)) {
                            updateMentionQuery(event.currentTarget.value, event.currentTarget.selectionStart);
                          }
                        }}
                        onKeyDown={handleQuestionKeyDown}
                        rows={1}
                        disabled={answerPending || session.activeAskChatId !== null || !chatId}
                        placeholder="Ask about this project or a ready file…"
                        aria-autocomplete="list"
                        aria-expanded={Boolean(mentionQuery && suggestions.length)}
                        aria-controls={mentionQuery && suggestions.length ? 'rag-chat-mention-options' : undefined}
                        aria-activedescendant={mentionQuery && suggestions[activeSuggestion] ? `rag-chat-file-option-${suggestions[activeSuggestion].id}` : undefined}
                        aria-invalid={questionTooLong || undefined}
                        aria-describedby={questionTooLong ? 'rag-chat-question-error rag-chat-composer-help' : 'rag-chat-composer-help'}
                      />
                      {mentionQuery && suggestions.length > 0 && (
                        <ul className="rag-chat-mention-options" id="rag-chat-mention-options" role="listbox" aria-label="Ready project files">
                          {suggestions.map((file, index) => (
                            <li key={file.id}>
                              <button
                                id={`rag-chat-file-option-${file.id}`}
                                type="button"
                                role="option"
                                aria-selected={index === activeSuggestion}
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => chooseMention(file)}
                              >
                                <span>{file.name}</span><small>{fileContentHint(file)}</small>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {composerNote && <p className="rag-chat-composer__note" role="status">{composerNote}</p>}
                      <div className="rag-chat-composer__footer">
                        <div className="rag-chat-composer__controls">
                          <button
                            className="rag-chat-composer__tools-toggle"
                            type="button"
                            aria-label={expanded ? 'Fewer options' : 'More options'}
                            title={expanded ? 'Fewer options' : 'More options'}
                            aria-expanded={expanded}
                            onClick={() => onToggleExpanded?.()}
                          >
                            {expanded ? <PanelLeftClose size={17} aria-hidden="true" /> : <PanelLeftOpen size={17} aria-hidden="true" />}
                            <span>{expanded ? 'Fewer options' : 'More options'}</span>
                          </button>
                          <label className="rag-chat-technical-option" title="Require a technical route and knowledge-base search.">
                            <input
                              className="sr-only"
                              type="checkbox"
                              role="switch"
                              checked={session.technicalQuestion}
                              onChange={event => setSessionTechnicalQuestion(event.target.checked)}
                              disabled={answerPending || session.activeAskChatId !== null || !chatId}
                              aria-label="Technical question"
                              aria-describedby="rag-chat-technical-help"
                            />
                            <span className="rag-chat-technical-option__track" aria-hidden="true" />
                            <span className="rag-chat-technical-option__label">Technical</span>
                            <span className="sr-only" id="rag-chat-technical-help">Require a technical route and knowledge-base search.</span>
                          </label>
                          <small className="rag-chat-composer__shortcut" id="rag-chat-composer-help">
                            <span aria-hidden="true">{`@ file · Enter newline · ${keyboardModifier}+↵ send`}</span>
                            <span className="sr-only">{`Use @ followed by a file name to mention a file. Press Enter for a new line; press ${keyboardModifierLabel} plus Enter to send.`}</span>
                          </small>
                        </div>
                        <div className="rag-chat-composer__actions">
                          <small className="rag-chat-composer__counter" aria-label={`${unicodeCharacterCount(question)} of ${MAX_QUESTION_LENGTH} characters`}>
                            {unicodeCharacterCount(question)} / {MAX_QUESTION_LENGTH}
                          </small>
                          <button className="button primary rag-chat-composer__send" type="submit" disabled={!question || questionTooLong || answerPending || session.activeAskChatId !== null || !chatId}>
                            <Send size={15} aria-hidden="true" />{answerPending ? 'Answer in progress' : 'Send'}
                          </button>
                        </div>
                      </div>
                    </div>
                    {questionTooLong && (
                      <p className="rag-chat-input-error" id="rag-chat-question-error" role="alert">
                        Too long: limit 4,000 characters and 8 KiB.
                      </p>
                    )}
                  </form>
                </>
              )}
              {(!session.selectedProjectId || !currentChat) && (
                <div className="rag-chat-options-footer">
                  <button
                    className="rag-chat-composer__tools-toggle"
                    type="button"
                    aria-label={expanded ? 'Fewer options' : 'More options'}
                    title={expanded ? 'Fewer options' : 'More options'}
                    aria-expanded={expanded}
                    onClick={() => onToggleExpanded?.()}
                  >
                    {expanded ? <PanelLeftClose size={17} aria-hidden="true" /> : <PanelLeftOpen size={17} aria-hidden="true" />}
                    <span>{expanded ? 'Fewer options' : 'More options'}</span>
                  </button>
                </div>
              )}
            </section>
          </div>
      {panelDialog?.type === 'todo' && (
        <AddTodoDialog
          project={panelDialog.project}
          initialText={panelDialog.message.content}
          sourceMessageId={panelDialog.message.id}
          onSave={saveTodoFromAnswer}
          onClose={closePanelDialog}
        />
      )}
      {panelDialog?.type === 'brief' && (
        <SaveBriefDialog
          project={panelDialog.project}
          initialText={panelDialog.message.content}
          sourceMessageId={panelDialog.message.id}
          onSave={saveBriefFromAnswer}
          onClose={closePanelDialog}
        />
      )}
      {panelDialog?.type === 'file' && (
        <FileBrowserDialog
          projectId={panelDialog.projectId}
          projectName={panelDialog.project.name}
          onAttached={reportAttachedFile}
          onClose={closePanelDialog}
        />
      )}
    </section>
  );
}
