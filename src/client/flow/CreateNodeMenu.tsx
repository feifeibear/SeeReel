import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Film, Globe, Image as ImageIcon, Mountain, Music2, Plus, Scissors, Upload, User } from "lucide-react";
import { useI18n } from "../i18n";
import { resolveCreateNodeMenuLayout } from "./createNodeMenuPosition";

export type CreateMenuOption = "character" | "scene" | "storyboard" | "shot" | "stitch" | "audioTrack" | "uploadCharacter" | "uploadScene" | "uploadVideo";

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
  const [menuSize, setMenuSize] = useState({ width: 320, height: 560 });
  const [viewportSize, setViewportSize] = useState(() => ({
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight
  }));

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
      if (e.key === "b" || e.key === "B") return safePick("storyboard");
      if (e.key === "n" || e.key === "N") return safePick("shot");
      if (e.key === "j" || e.key === "J") return safePick("stitch");
      if (e.key === "a" || e.key === "A") return safePick("audioTrack");
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

  useEffect(() => {
    const onResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const width = Math.ceil(rect.width);
    const height = Math.ceil(node.scrollHeight || rect.height);
    if (width && height && (Math.abs(width - menuSize.width) > 1 || Math.abs(height - menuSize.height) > 1)) {
      setMenuSize({ width, height });
    }
  }, [menuSize.height, menuSize.width, viewportSize.width]);

  const layout = useMemo(() => resolveCreateNodeMenuLayout({
    anchorX: x,
    anchorY: y,
    viewportWidth: viewportSize.width,
    viewportHeight: viewportSize.height,
    menuWidth: menuSize.width,
    menuHeight: menuSize.height
  }), [menuSize.height, menuSize.width, viewportSize.height, viewportSize.width, x, y]);

  const items: Array<{ key: CreateMenuOption; icon: ReactElement; label: string; hint: string; tag: string }> = [
    { key: "character", icon: <User size={14} />, label: t.menu.character, hint: t.menu.characterHint, tag: "C" },
    { key: "scene", icon: <Mountain size={14} />, label: t.menu.scene, hint: t.menu.sceneHint, tag: "S" },
    { key: "storyboard", icon: <ImageIcon size={14} />, label: t.menu.storyboard, hint: t.menu.storyboardHint, tag: "B" },
    { key: "shot", icon: <Plus size={14} />, label: t.menu.shot, hint: t.menu.shotHint, tag: "N" },
    { key: "stitch", icon: <Scissors size={14} />, label: t.menu.stitch, hint: t.menu.stitchHint, tag: "J" },
    { key: "audioTrack", icon: <Music2 size={14} />, label: t.menu.audioTrack, hint: t.menu.audioTrackHint, tag: "A" },
    { key: "uploadCharacter", icon: <Upload size={14} />, label: t.menu.uploadCharacter, hint: t.menu.uploadCharacterHint, tag: "U" },
    { key: "uploadScene", icon: <ImageIcon size={14} />, label: t.menu.uploadScene, hint: t.menu.uploadSceneHint, tag: "V" },
    { key: "uploadVideo", icon: <Film size={14} />, label: t.menu.uploadVideo, hint: t.menu.uploadVideoHint, tag: "R" }
  ];

  return (
    <div
      ref={ref}
      className="create-node-menu"
      style={{ left: layout.left, top: layout.top, maxHeight: layout.maxHeight }}
      data-placement-x={layout.placementX}
      data-placement-y={layout.placementY}
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
