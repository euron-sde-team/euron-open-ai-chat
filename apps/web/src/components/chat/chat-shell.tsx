"use client";

/**
 * The app frame: the sidebar (collapsible on desktop, a sheet on phones) and the main
 * area. Signed-out visitors are sent to sign in. The collapsed choice is a device
 * preference kept in localStorage.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn, Sheet, SheetContent } from "@open-chat/ui";
import { RequireAuth } from "@/components/common/require-auth";
import { ShellContext } from "./shell-context";
import { Sidebar } from "./sidebar";

const KEY = "chat.sidebar.collapsed";

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return mobile;
}

export function ChatShell({ children }: { children: ReactNode }) {
  const mobile = useIsMobile();
  const [collapsed, setCollapsed] = useState(false);
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(KEY) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);
  const setCollapsedSaved = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* storage blocked */
    }
  };

  return (
    <RequireAuth>
      <ShellContext.Provider value={{ collapsed, mobile, open: () => (mobile ? setSheet(true) : setCollapsedSaved(false)) }}>
        <div className="flex h-dvh overflow-hidden">
          {!mobile ? (
            <aside className={cn("shrink-0 border-r border-border transition-[width] duration-200", collapsed ? "w-0 overflow-hidden border-r-0" : "w-[272px]")}>
              <div className="h-full w-[272px]">
                <Sidebar onCollapse={() => setCollapsedSaved(true)} />
              </div>
            </aside>
          ) : (
            <Sheet open={sheet} onOpenChange={setSheet}>
              <SheetContent side="left" width="max-w-[300px]" className="w-[86vw] p-0" aria-label="Chats">
                <Sidebar onNavigate={() => setSheet(false)} />
              </SheetContent>
            </Sheet>
          )}
          <main id="main" className="min-w-0 flex-1">
            {children}
          </main>
        </div>
      </ShellContext.Provider>
    </RequireAuth>
  );
}
