"use client";

/** Share a chat: freezes the branch on screen into a public link. Later messages stay private. */
import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import type { Share } from "@open-chat/types";
import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input, toast } from "@open-chat/ui";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/errors";

export function ShareDialog({ conversationId, title, open, onOpenChange }: { conversationId: string; title: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [share, setShare] = useState<Share | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      setShare(await api().shares.create(conversationId));
    } catch (err) {
      toast.error({ title: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    if (!share) return;
    void navigator.clipboard.writeText(share.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (onOpenChange(o), !o && setShare(null))}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{title}&rdquo;</DialogTitle>
          <DialogDescription>Anyone with the link can read the conversation as it is now. Messages you send later are not shared, and you can revoke the link in Settings.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          {share ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="secondary" onClick={copy} aria-label="Copy link">
                {copied ? <Check /> : <Copy />}
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-[14px] text-muted-foreground">
              <Link2 className="size-4" /> Names of attached files are shown; their contents are not.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          {share ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button onClick={() => void create()} loading={busy}>
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
