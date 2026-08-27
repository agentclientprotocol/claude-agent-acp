# Cross-session references

The adapter resolves an ACP `resource_link` as a Claude session reference when its URI has this form:

```text
acp-session://reference?sessionId=<Claude session id>
```

The client can include extra query parameters for its own navigation. The adapter reads only `sessionId`.

This URI is an adapter convention inside the standard ACP `resource_link` block. It does not add an ACP method or schema field.

Before a prompt or steering request starts, the adapter calls `getSessionMessages`.
It uses the active working directory and sets `includeSystemMessages: true`.
It replaces the link with an embedded JSON resource:

```json
{
  "type": "session_reference",
  "sessionId": "source-session-id",
  "title": "Source chat",
  "messages": []
}
```

The adapter preserves the order of prompt blocks. It leaves resource links with other URI schemes unchanged.

The adapter rejects a reference to the active Claude session. A failed SDK read also fails the prompt request.
The adapter sends the full message history and does not truncate or summarize it.
