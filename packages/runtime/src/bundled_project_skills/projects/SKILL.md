---
name: projects
description: Organize chats into projects, including sidebar groups, shared pins and ordering. Use when the user asks to organize their chats or work.
---

Projects are named groups of sessions. In the frontend sidebar, users see root sessions grouped under their project; child agents remain under their parent session. Unfiled sessions appear outside project groups. Pins and project order are shared, not personal preferences.

Like a chat, a project is shared with the workspace or Only me (visibility "private"). An Only me project is seen only by its owner and their agent turns, and holds only the owner's own Only me chats and Sites; any other session or Site is refused. project_create from an Only me chat makes an Only me project for that chat's owner; from any other chat it is shared. Only the owner can share an Only me project, in the app, and a shared project never becomes Only me.

Use project_list to find an existing group; project_create only when a new group is useful. project_update changes its name, description, avatar or pinned state. A description and avatar are the project's profile, like a chat's: people see the avatar in place of the folder icon and the description when they point at the project; set them when the person asks or when creating a project they described. project_reorder takes every current project ID once; pinned projects appear first. Use sessions_list with projectId to find visible sessions (null means unfiled), and session_set_project to file/unfile a session. session_create accepts projectId when creating new work is already warranted. Prefer filing the root session the user sees.

Projects organize work only: they are not repository folders and do not supply instructions, tools, secrets, runtime defaults or extra access. Moving a session preserves its execution and history. project_delete removes the group and unfiles its sessions; it does not delete or stop them. Use only the tools available to this session.
