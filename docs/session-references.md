# Cross-session references

The adapter resolves an ACP `resource_link` as a Claude session reference when its URI has this form:

```text
acp-session://reference?sessionId=<Claude session id>
```

The client can include extra query parameters for its own navigation. The adapter reads only `sessionId`.

This URI is an adapter convention inside the standard ACP `resource_link` block. It does not add an ACP method or schema field.

## The reference becomes a one-line mention

The adapter replaces the link with one markdown link, in the position the link occupied:

```text
[Claude session "Source chat"](claude://sessions/source-session)
```

That is the whole resolution, and it is what lands in the stored transcript. `acp-session:` is the
client's wire format and stops at the adapter boundary; the model sees a title and an id.

There is no standard to follow here, so this is an adapter convention. ACP defines `resource_link`
but no way to point at another agent session. Codex's `codex://threads/<id>` is a desktop deep link
its app resolves, not a model affordance. The `prompt:` URI scheme
([draft-boone-prompt-uri-scheme](https://datatracker.ietf.org/doc/draft-boone-prompt-uri-scheme/))
is an individual Internet-Draft with no adoption. The mention above is therefore written for the
model rather than for a URL handler: it says "session", carries the id, and fits on one line.

The referenced transcript is not inlined, because a chat is usually far larger than the part that
matters. The model opens the reference with the session-management tools when it needs to —
`mcp__ccd_session_mgmt__list_events` for the turns, `get_session` for metadata,
`search_session_transcripts` to find one part of it. The mention does not describe those tools;
their own descriptions do.

The rewrite happens in `promptToClaude`, in the same `resource_link` branch that already turns
`file://` and `zed://` links into `[@name](uri)` — a session link is just one more scheme handled
there, not a separate pass over the prompt. A string compare on the URI decides it, so ordinary
links cost nothing extra, and block order is preserved because nothing is reordered.

Resolution is local and synchronous: the adapter reads no session history itself, so a prompt
carrying a reference cannot fail on a transcript read. If the session-management tools are not
available in the host, the reference is a link the model cannot open. A reference to the active
Claude session is rejected with `invalid_params`.
