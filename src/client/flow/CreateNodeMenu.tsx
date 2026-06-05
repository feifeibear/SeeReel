import { useCallback, useEffect, useRef, type ReactElement } from "react";
import { Film, Globe, Image as ImageIcon, Mountain, Plus, Scissors, Upload, User } from "lucide-react";
import { useI18n } from "../i18n";

export type CreateMenuOption = "character" | "scene" | "shot" | "stitch" | "uploadCharacter" | "uploadScene" | "uploadVideo";

interface CreateNodeMenuProps {
  /** Anchor position in viewport coords (clientX/Y from the context-menu event). */
  x: number;
  y: number;
  onPick: (option: CreateMenuOption) => void;
  onClose: () => void;
}

/**
 * Floating "新建节点" mini-menu shown when the user right-clicks an empty area of the canvas.
 * Project-specific quick-create menu constrained to the node types supported by the SeeReel
 * workflow canvas (the design rationale lives in docs/canvas-node-model.md):
 *   - 角色锚 (character)
 *   - 场景锚 (scene)
 *   - 分镜镜头 (shot — backend appends one shot, derives storyboard + video nodes)
 *   - 上传图 (upload — drop-equivalent, asks the user to pick character vs scene)
 *
 * Closes on Escape, click-outside, and after picking an option. Uses a `pickedRef` guard to
 * make the pick action one-shot — once an option fires, subsequent clicks / keystrokes are
 * ignored even if the parent hasn't yet unmounted us. This prevents the "user clicked twice
 * in a row → 2 anchors created" bug.
 */
export function CreateNodeMenu({ x, y, onPick, onClose }: CreateNodeMenuProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement | null>(null);
  const pickedRef = useRef(false);

  const safePick = useCallback((option: CreateMenuOption) => {
    if (pickedRef.current) return;
    pickedRef.current = true;
    onPick(option);
  }, [onPick]);

  const safeClose = useCallback(() => {
    if (pickedRef.current) return;
    onClose();
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (pickedRef.current) return;
      // Ignore hotkeys while a text input has focus — otherwise typing "C" / "S" / "N" / "U" / "V"
      // in a textarea or input would silently spawn a node.
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      if (e.key === "Escape") return safeClose();
      if (e.key === "c" || e.key === "C") return safePick("character");
      if (e.key === "s" || e.key === "S") return safePick("scene");
      if (e.key === "n" || e.key === "N") return safePick("shot");
      if (e.key === "j" || e.key === "J") return safePick("stitch");
      if (e.key === "u" || e.key === "U") return safePick("uploadCharacter");
      if (e.key === "v" || e.key === "V") return safePick("uploadScene");
      if (e.key === "r" || e.key === "R") return safePick("uploadVideo");
    };
    const onClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) safeClose();
    };
    window.addEventListener("keydown", onKey);
    // setTimeout so the same context-menu click that opened us doesn't close us immediately.
    const t = window.setTimeout(() => window.addEventListener("click", onClick), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      window.clearTimeout(t);
    };
  }, [safeClose, safePick]);

  // Clamp to viewport so the menu doesn't get cut off near the right/bottom edge.
  const left = Math.min(x, window.innerWidth - 240);
  const top = Math.min(y, window.innerHeight - 320);

  const items: Array<{ key: CreateMenuOption; icon: ReactElement; label: string; hint: string; tag: string }> = [
    { key: "character", icon: <User size={14} />, label: t.menu.character, hint: t.menu.characterHint, tag: "C" },
    { key: "scene", icon: <Mountain size={14} />, label: t.menu.scene, hint: t.menu.sceneHint, tag: "S" },
    { key: "shot", icon: <Plus size={14} />, label: t.menu.shot, hint: t.menu.shotHint, tag: "N" },
    { key: "stitch", icon: <Scissors size={14} />, label: t.menu.stitch, hint: t.menu.stitchHint, tag: "J" },
    { key: "uploadCharacter", icon: <Upload size={14} />, label: t.menu.uploadCharacter, hint: t.menu.uploadCharacterHint, tag: "U" },
    { key: "uploadScene", icon: <ImageIcon size={14} />, label: t.menu.uploadScene, hint: t.menu.uploadSceneHint, tag: "V" },
    { key: "uploadVideo", icon: <Film size={14} />, label: t.menu.uploadVideo, hint: t.menu.uploadVideoHint, tag: "R" }
  ];

  return (
    <div
      ref={ref}
      className="create-node-menu"
      style={{ left, top }}
      role="menu"
      aria-label={t.menu.aria}
      onClick={(e) => e.stopPropagation()}
    >
      <header>
        <Globe size={13} />
        <span>{t.menu.title}</span>
        <small>{t.menu.hint}</small>
      </header>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="create-node-menu-item"
          onClick={() => safePick(item.key)}
        >
          <span className="cnm-icon">{item.icon}</span>
          <span className="cnm-label">
            <strong>{item.label}</strong>
            <small>{item.hint}</small>
          </span>
          <kbd className="cnm-key">{item.tag}</kbd>
        </button>
      ))}
    </div>
  );
}
