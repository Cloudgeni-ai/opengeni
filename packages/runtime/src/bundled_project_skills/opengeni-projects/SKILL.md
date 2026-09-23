---
name: opengeni-projects
description: Organize OpenGeni sessions into projects, including sidebar groups, shared pins and ordering. Use when the user asks to organize their work in OpenGeni.
---

Projects are named, workspace-shared groups of sessions. In the frontend sidebar, users see root sessions grouped under their project; child agents remain under their parent session. Unfiled sessions appear outside project groups. Pins and project order are shared, not personal preferences.

Use project_list to find an existing group; project_create only when a new group is useful. project_update changes its name, description or pinned state. project_reorder takes every current project ID once; pinned projects appear first. Use sessions_list with projectId to find visible sessions (null means unfiled), and session_set_project to file/unfile a session. session_create accepts projectId when creating new work is already warranted. Prefer filing the root session the user sees.

Projects organize work only: they are not repository folders and do not supply instructions, tools, secrets, runtime defaults or extra access. Moving a session preserves its execution and history. project_delete removes the group and unfiles its sessions; it does not delete or stop them. Use only the tools available to this session.
