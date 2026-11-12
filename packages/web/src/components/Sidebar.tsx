import { Link, useRouterState, useSearch } from "@tanstack/react-router";

import { isNavItemActive, NAV_SECTIONS, VOICE_TAB_TITLES } from "./nav-items";

const qgridVersion = __QGRID_CLI_VERSION__;

interface SidebarProps {
  className?: string;
}

export default function Sidebar({ className }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { tab: currentTab = "tts" } = useSearch({ strict: false });

  return (
    <aside
      className={`hidden md:flex w-[200px] bg-sand-50 flex-col shrink-0 border-r border-sand-200/40 ${className ?? ""}`}
    >
      <div className="h-11 flex items-center px-4 border-b border-sand-200/30">
        <span className="text-[13px] font-semibold text-sand-800 tracking-tight">Qgrid</span>
      </div>

      <nav className="flex-1 px-2.5 py-3 space-y-4 overflow-y-auto">
        {NAV_SECTIONS.map((section) => (
          <div key={section.label}>
            <div className="px-2 pb-1.5">
              <span className="text-[10px] uppercase tracking-[0.08em] text-sand-400 font-medium">
                {section.label}
              </span>
            </div>
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const active = isNavItemActive(item.path, pathname);
                // With sub-items, the active sub-item carries the highlight; the parent keeps only
                // its color.
                const highlighted = active && !item.tabs;

                return (
                  <div key={item.path} className="space-y-0.5">
                    <Link
                      to={item.path}
                      className={`flex items-center gap-2 px-2 py-[6px] rounded-[7px] text-[13px] no-underline transition-all duration-150 ${
                        highlighted
                          ? "bg-sand-200/60 text-sand-900 font-medium"
                          : active
                            ? "text-sand-900 font-medium hover:bg-sand-100"
                            : "text-sand-500 hover:bg-sand-100 hover:text-sand-700"
                      }`}
                      style={
                        highlighted
                          ? {
                              boxShadow:
                                "0 0.5px 1px rgba(0,0,0,0.04), inset 0 0.5px 0 rgba(255,255,255,0.6)",
                            }
                          : undefined
                      }
                    >
                      <item.icon
                        className={`size-[15px] shrink-0 ${active ? "text-sienna-500" : "text-sand-400"}`}
                      />
                      <span>{item.title}</span>
                    </Link>
                    {item.tabs?.map((tab) => {
                      const tabActive = active && currentTab === tab;

                      return (
                        <Link
                          key={tab}
                          to={item.path}
                          search={{ tab }}
                          className={`flex items-center pl-[31px] pr-2 py-[5px] rounded-[7px] text-[12.5px] no-underline transition-all duration-150 ${
                            tabActive
                              ? "bg-sand-200/60 text-sand-900 font-medium"
                              : "text-sand-500 hover:bg-sand-100 hover:text-sand-700"
                          }`}
                        >
                          {VOICE_TAB_TITLES[tab]}
                        </Link>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-4 py-3 border-t border-sand-200/30">
        <div className="flex items-center gap-2">
          <div className="size-1.5 rounded-full bg-sage-400" />
          <span className="text-[10px] text-sand-400">v{qgridVersion}</span>
        </div>
      </div>
    </aside>
  );
}
