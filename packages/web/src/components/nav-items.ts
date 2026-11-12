import type React from "react";
import AudioLinesIcon from "~icons/lucide/audio-lines";
import ActivityIcon from "~icons/lucide/file-text";
import GaugeIcon from "~icons/lucide/home";
import KeyRoundIcon from "~icons/lucide/key-round";
import SettingsIcon from "~icons/lucide/settings";
import TerminalIcon from "~icons/lucide/terminal";

/** Voice 플레이그라운드의 도구. 사이드바가 Voice 아래에 나열하고, 페이지는 `?tab=` 으로 고른다. */
export const VOICE_TAB_IDS = ["tts", "stt", "live"] as const;

export type VoiceTab = (typeof VOICE_TAB_IDS)[number];

export const VOICE_TAB_TITLES: Record<VoiceTab, string> = {
  tts: "TTS",
  stt: "STT",
  live: "Live Conversation",
};

export type NavItem = {
  title: string;
  /** 좁은 화면 탭 바용 짧은 라벨. 없으면 title 을 쓴다. */
  shortTitle?: string;
  path: string;
  icon: React.FC<React.SVGProps<SVGSVGElement>>;
  /** 사이드바에서 항목 아래에 펼치는 하위 도구(데스크톱 전용). */
  tabs?: readonly VoiceTab[];
};

export type NavSection = {
  label: string;
  items: NavItem[];
};

/** 사이드바(데스크톱)와 하단 탭 바(모바일)가 공유하는 단일 정의. */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", path: "/", icon: GaugeIcon }],
  },
  {
    label: "Manage",
    items: [
      { title: "Tokens", path: "/tokens", icon: KeyRoundIcon },
      { title: "Request Logs", shortTitle: "Logs", path: "/logs", icon: ActivityIcon },
      { title: "Server Logs", shortTitle: "Server", path: "/monit", icon: TerminalIcon },
      { title: "Settings", path: "/settings", icon: SettingsIcon },
    ],
  },
  {
    label: "Playground",
    items: [{ title: "Voice", path: "/voice", icon: AudioLinesIcon, tabs: VOICE_TAB_IDS }],
  },
];

export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

export function isNavItemActive(path: string, pathname: string): boolean {
  if (path === "/") return pathname === "/" || pathname === "";

  return pathname.startsWith(path);
}
