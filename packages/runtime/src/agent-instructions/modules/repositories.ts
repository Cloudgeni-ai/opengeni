import {
  blocks,
  bullets,
  sentences,
  type AgentPromptContext,
  type AgentPromptModule,
} from "../types";

/**
 * Which GitHub identity each mounted repository acts as, and what that means
 * for tools. Absent unless a repository is mounted as the person, so App-only
 * sessions keep their prompt bytes.
 */
function repositoryIdentityBlock(context: AgentPromptContext): string | null {
  const identities = context.resources.repositoryIdentities ?? [];
  const personal = identities.some((repository) => repository.identity === "personal");
  if (!personal) return null;
  const app = identities.some((repository) => repository.identity === "app");
  return blocks(
    "GitHub identity per mounted repository:",
    bullets(
      ...identities.map((repository) =>
        repository.identity === "personal"
          ? `\`${repository.path}\`: as the person${repository.login ? ` (@${repository.login})` : ""}, through Your GitHub. Commits, branches, pull requests and reviews appear under their name.`
          : `\`${repository.path}\`: as the Opengeni app. Work appears as the Opengeni bot.`,
      ),
    ),
    sentences(
      "On repositories mounted as the person, use plain git and the github_personal__* tools; gh and raw GitHub API calls do not act as the person and must not be used there.",
      app && "On Opengeni app repositories, use the github_app__* tools.",
    ),
  );
}

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
  render: (context) => {
    const personal = (context.resources.repositoryIdentities ?? []).some(
      (repository) => repository.identity === "personal",
    );
    return blocks(
      "# Repositories and Git",
      sentences(
        context.resources.repositories &&
          "Repository resources are mounted under repos/<host>/<owner>/<repo> unless the session specifies another collision-free mount path.",
        context.resources.managedSandbox &&
          (personal
            ? "Provider CLIs such as gh, glab, and az may be pre-authenticated by the host through brokered git credentials or a sandbox preparation profile for repositories that are not mounted as the person; try them there before asking for credentials."
            : "Provider CLIs such as gh, glab, and az may be pre-authenticated by the host through brokered git credentials or a sandbox preparation profile; try them before asking for credentials."),
        "When the Git repository you change has a remote and git provider credentials are available, work on a focused branch and open a pull request.",
        "Otherwise leave changes in the working tree and do not create or mention branches, commits, or pull requests unless the user asks; if the repository has a remote, say the changes are not pushed, and if the user asks for something you cannot make, say what blocks it.",
      ),
      repositoryIdentityBlock(context),
      "You may find yourself working in a dirty worktree. Existing or new changes belong to the user unless you know otherwise, so you preserve them, ignore unrelated edits, and work carefully with anything that overlaps your task. If you cannot work around them you escalate to the user.",
      "Never use destructive commands like `git reset --hard` or `git checkout --` unless the user has clearly asked for that operation. If the request is ambiguous, ask for approval first. You prefer non-interactive git commands.",
    );
  },
};
