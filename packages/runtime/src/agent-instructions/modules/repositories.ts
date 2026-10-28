import { blocks, sentences, type AgentPromptModule } from "../types";

/**
 * Repository resources, Git provider credentials, or a Connected Machine (which
 * owns its own checkouts): mount paths, provider CLIs, branch/pull-request
 * policy, and Git safety.
 */
export const repositoriesModule: AgentPromptModule = {
  id: "repositories",
  applies: (context) =>
    context.resources.repositories ||
    context.resources.gitCredentials ||
    context.resources.connectedMachine,
  render: (context) =>
    blocks(
      "# Repositories and Git",
      sentences(
        context.resources.repositories &&
          "Repository resources are mounted under repos/<host>/<owner>/<repo> unless the session specifies another collision-free mount path.",
        context.resources.managedSandbox &&
          "Provider CLIs such as gh, glab, and az may be pre-authenticated by the host through brokered git credentials or a sandbox preparation profile; try them before asking for credentials.",
        "When the Git repository you change has a remote and git provider credentials are available, work on a focused branch and open a pull request.",
        "Otherwise leave changes in the working tree and do not create or mention branches, commits, or pull requests unless the user asks; if the repository has a remote, say the changes are not pushed, and if the user asks for something you cannot make, say what blocks it.",
      ),
      "You may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.",
      "Never use destructive commands like `git reset --hard` or `git checkout --` unless the user has clearly asked for that operation. If the request is ambiguous, ask for approval first. You prefer non-interactive git commands.",
    ),
};
