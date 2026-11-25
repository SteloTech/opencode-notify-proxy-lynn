export type Status = "succeeded" | "failed" | "interrupted"

export type Notification = { title: string; body: string }

/** A generated notification, and whether the user needs it when that was asked. */
export type Decision = Notification & { notify?: boolean }

export type Limits = { title: number; body: number }

export const defaultLimits: Limits = { title: 40, body: 140 }

const describe: Record<Status, string> = {
  succeeded: "finished its work",
  failed: "stopped because of an error",
  interrupted: "was stopped before it finished",
}

/**
 * The side question sent through `session.generate`, which sees the session's full history. With `decide`, the
 * model also says whether the run told the user anything worth a notification (runs the user didn't start).
 */
export function prompt(status: Status, limits: Limits, error?: string, decide = false) {
  return [
    "The user is away from their computer. The agent in this conversation just",
    `${describe[status]}.${error ? ` The error was: ${error}` : ""}`,
    "Write the iOS push notification they will see on their lock screen.",
    ...(decide
      ? [
          "The user didn't send the message that started this run, so first decide whether it needs their attention.",
          "notify is true when the agent's latest reply tells them something: a result, an answer, news, a decision or",
          "question for them, or a problem. It is false when the run was housekeeping with nothing new to say, such as",
          "acknowledging a background job, a routine check that found nothing, or repeating what they already know.",
        ]
      : []),
    "",
    "Reply with only a JSON object and nothing else, no code fence:",
    decide ? '{"notify": true, "title": "...", "body": "..."}' : '{"title": "...", "body": "..."}',
    "",
    `- title: at most ${limits.title} characters. Name the task or its outcome. No trailing period.`,
    `- body: at most ${limits.body} characters. Say what happened and anything the user must do next.`,
    "- Plain text only: no markdown, no emoji, no quotes around file names.",
    "- It passes through outside services: no file paths, URLs, secrets, or raw error text.",
    "- Do not call any tools and do not take any actions.",
  ].join("\n")
}

/** Extracts `{title, body}` from a model reply, tolerating code fences and surrounding prose. */
export function parse(text: string, limits: Limits): Decision | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  let value: unknown
  try {
    value = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const { title, body, notify } = value as Record<string, unknown>
  // Not worth a notification: the title and body don't matter.
  if (notify === false) return { title: "", body: "", notify: false }
  if (typeof title !== "string" || typeof body !== "string") return undefined
  const clean = { title: clip(title, limits.title), body: clip(body, limits.body) }
  if (!clean.title || !clean.body) return undefined
  return typeof notify === "boolean" ? { ...clean, notify } : clean
}

/** Never includes the error itself: its text can carry paths, URLs or secrets. */
export function fallback(status: Status, sessionTitle: string | undefined, limits: Limits): Notification {
  const title = clip(sessionTitle || "OpenCode", limits.title)
  const body =
    status === "succeeded" ? "Finished." : status === "interrupted" ? "Stopped before finishing." : "Stopped because of an error."
  return { title, body: clip(body, limits.body) }
}

/** Collapses whitespace and shortens to `max` characters, preferring a word boundary. */
export function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  if (chars.length <= max) return flat
  const cut = chars.slice(0, max - 1).join("")
  const space = cut.lastIndexOf(" ")
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, "")}…`
}
