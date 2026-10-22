import {
  ActivityIcon,
  AppWindowIcon,
  ArchiveIcon,
  BellIcon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  BrainCircuitIcon,
  CalendarClockIcon,
  CircleDotIcon,
  ClipboardIcon,
  CodeIcon,
  DownloadIcon,
  FileDiffIcon,
  FileIcon,
  FileSearchIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FolderGitIcon,
  FolderIcon,
  GlobeIcon,
  HandIcon,
  HourglassIcon,
  ImageIcon,
  InboxIcon,
  KeyboardIcon,
  KeyRoundIcon,
  LogInIcon,
  MessageCircleQuestionIcon,
  MessagesSquareIcon,
  MessageSquareIcon,
  MonitorIcon,
  PackageSearchIcon,
  PanelsTopLeftIcon,
  PaperclipIcon,
  PencilIcon,
  PlugIcon,
  ReceiptIcon,
  SearchIcon,
  ServerCogIcon,
  ServerIcon,
  SettingsIcon,
  Share2Icon,
  SparklesIcon,
  TargetIcon,
  TerminalIcon,
  VideoIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import type { ToolIconKind } from "./tool-presentation";

/**
 * The icon for a presentation kind, looked up when a row renders. A module-level
 * table would capture the icons at load time; in a bundle where this module and
 * the icon library's chunk import each other, an icon can still be undefined
 * then, and the row would render an undefined component (React #130).
 */
export function toolIcon(kind: ToolIconKind): LucideIcon {
  switch (kind) {
    case "terminal":
      return TerminalIcon;
    case "keyboard":
      return KeyboardIcon;
    case "file-diff":
      return FileDiffIcon;
    case "search":
      return SearchIcon;
    case "question":
      return MessageCircleQuestionIcon;
    case "target":
      return TargetIcon;
    case "brain":
      return BrainCircuitIcon;
    case "sessions":
      return MessagesSquareIcon;
    case "server":
      return ServerIcon;
    case "server-cog":
      return ServerCogIcon;
    case "calendar":
      return CalendarClockIcon;
    case "panels":
      return PanelsTopLeftIcon;
    case "share":
      return Share2Icon;
    case "message":
      return MessageSquareIcon;
    case "git":
      return FolderGitIcon;
    case "box":
      return BoxIcon;
    case "key":
      return KeyRoundIcon;
    case "file-search":
      return FileSearchIcon;
    case "package-search":
      return PackageSearchIcon;
    case "plug":
      return PlugIcon;
    case "browser":
      return GlobeIcon;
    case "screen":
      return MonitorIcon;
    case "spreadsheet":
      return FileSpreadsheetIcon;
    case "wait":
      return HourglassIcon;
    case "download":
      return DownloadIcon;
    case "clipboard":
      return ClipboardIcon;
    case "image":
      return ImageIcon;
    case "video":
      return VideoIcon;
    case "record":
      return CircleDotIcon;
    case "document":
      return FileTextIcon;
    case "file":
      return FileIcon;
    case "attachment":
      return PaperclipIcon;
    case "archive":
      return ArchiveIcon;
    case "folder":
      return FolderIcon;
    case "site":
      return AppWindowIcon;
    case "guide":
      return BookOpenIcon;
    case "settings":
      return SettingsIcon;
    case "bell":
      return BellIcon;
    case "inbox":
      return InboxIcon;
    case "help":
      return HandIcon;
    case "model":
      return SparklesIcon;
    case "progress":
      return ActivityIcon;
    case "helper":
      return BotIcon;
    case "sign-in":
      return LogInIcon;
    case "code":
      return CodeIcon;
    case "accounting":
      return ReceiptIcon;
    case "rename":
      return PencilIcon;
    case "wrench":
      return WrenchIcon;
  }
}

/** A tool kind's icon as an element. */
export function ToolKindIcon({ kind, className }: { kind: ToolIconKind; className?: string }) {
  const Icon = toolIcon(kind);
  return <Icon className={className} />;
}
