---
name: "Create Memory"
description: "Create a new memory node in memory/nodes/"
version: "1.0.0"
disable-model-invocation: false
user-invocable: true
---

# Create Memory

This skill creates a new memory node in the `memory/nodes/` directory.

## Arguments

`$ARGUMENTS` — a description of what to remember. The agent will extract the title, content, and type from the conversation context.

## Usage

When invoked, create a markdown file at `memory/nodes/<slug>.md` with YAML frontmatter:

```yaml
---
id: <generated-id>
type: concept | experience | project | people
domain: general
tags: []
related: []
priority: 5
status: active
title: "<title>"
---
```

The content should be the full memory in Markdown format.

## Steps

1. Extract the key information from the conversation
2. Determine the appropriate type (concept, experience, project, or people)
3. Generate a slug from the title
4. Write the memory node file
5. Update memory/index.json to include the new node
