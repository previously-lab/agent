## Previously v0.1.0 — Previously on you.

Previously is a lightweight cloud agent with episodic memory. There are no conversations — just one continuous timeline. Every interaction is stored as plain Markdown in your own GitHub repo, readable by any AI tool.

**This is an early experimental release.** Not production-ready, but fully functional and openly shared because the ideas deserve discussion.

### What's different

**No conversations.** Chat threads are replaced by **time slices** — one file per conversation burst, organized by date on a vertical timeline. Scroll up to revisit years ago. Scroll down to continue where you left off.

**Episodic memory, not a vector database.** Time slices carry YAML frontmatter with focus, summary, decisions, and tags. Keywords woven across slices form **strands** — "the whole history of that thing" across months and years. No embeddings, no black boxes. Human-readable Markdown.

**Memory is yours.** Everything lives in your own GitHub repo as plain files. Previously writes them. Claude Code reads them. Codex extends them. Git is your version control for memory.

### Try it

**[previously-demo.ldwid.com](https://previously-demo.ldwid.com)** — a read-only demo with a fictional persona spanning several years of conversations.

### What's next

Parallel timeline indexing · Multi-branch memory with git-native version control · Connector framework for cloud-local agent hybrid · Semantic memory extraction from episodic data.

[Full roadmap →](https://github.com/previously-lab/agent#roadmap)

---

This is a one-person research project. Ideas and bug reports welcome on [GitHub Issues](https://github.com/previously-lab/agent/issues).
