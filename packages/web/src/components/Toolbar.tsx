import { Link, useRouterState, useSearch } from "@tanstack/react-router";

import { VOICE_TAB_TITLES, type VoiceTab } from "./nav-items";

const ROUTE_TITLES = new Map<string, string>(
  Object.entries({
    "/": "Dashboard",
    "/tokens": "Tokens",
    "/logs": "Request Logs",
    "/monit": "Server Logs",
    "/voice": "Voice",
  }),
);

interface Breadcrumb {
  parent?: string;
  parentPath?: string;
  current: string;
}

function getBreadcrumb(pathname: string, voiceTab: VoiceTab): Breadcrumb {
  if (pathname.startsWith("/requests/show")) {
    return { parent: "Request Logs", parentPath: "/logs", current: "Detail" };
  }

  if (pathname === "/voice") {
    return { parent: "Voice", parentPath: "/voice", current: VOICE_TAB_TITLES[voiceTab] };
  }

  return { current: ROUTE_TITLES.get(pathname) ?? pathname };
}

export function Toolbar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { tab = "tts" } = useSearch({ strict: false });
  const crumb = getBreadcrumb(pathname, tab);

  return (
    <div className="toolbar-glass h-11 shrink-0 flex items-center px-5">
      <nav className="flex items-center gap-1.5 text-[13px]">
        {crumb.parent && crumb.parentPath && (
          <>
            <Link
              to={crumb.parentPath}
              className="text-sand-400 hover:text-sand-600 transition-colors no-underline"
            >
              {crumb.parent}
            </Link>
            <span className="text-sand-300 select-none">/</span>
          </>
        )}
        <span className="font-medium text-sand-800">{crumb.current}</span>
      </nav>
    </div>
  );
}
