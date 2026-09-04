import DOMPurify from "dompurify";
import { renderMermaidSvg, type MermaidTheme } from "@openclaw/mermaid-renderer";
import { css, html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { resolveThemeColor } from "../lib/theme-color.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { highlightCodeHtml } from "./markdown-code-blocks.ts";
import { icons } from "./icons.ts";
import "./image-lightbox.ts";
import "./web-awesome.ts";

const CACHE_LIMIT = 16;
const diagrams = new Map<string, Promise<string>>();

function isSvgSource(source: string): boolean {
  return /^\s*<svg(?:\s|>)/iu.test(source);
}

function sanitizeSvgSource(source: string): string {
  const sanitized = DOMPurify.sanitize(source, { USE_PROFILES: { svg: true } });
  if (!isSvgSource(sanitized)) {
    throw new Error("Invalid SVG source");
  }
  return sanitized;
}

function currentTheme(): MermaidTheme {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const darkMode = root.dataset.themeMode === "dark";
  return {
    background: resolveThemeColor(styles, "--card") || (darkMode ? "#181818" : "#ffffff"),
    foreground: resolveThemeColor(styles, "--text") || (darkMode ? "#eeeeee" : "#171717"),
    muted: resolveThemeColor(styles, "--muted") || "#888888",
    border: resolveThemeColor(styles, "--border-hover") || "#888888",
    accent: resolveThemeColor(styles, "--accent") || "#888888",
    fontFamily: styles.getPropertyValue("--font-body").trim() || "system-ui, sans-serif",
    darkMode,
  };
}

function cachedDiagram(key: string, source: string, theme: MermaidTheme): Promise<string> {
  let result = diagrams.get(key);
  if (result) {
    diagrams.delete(key);
  } else {
    result = renderMermaidSvg(source, theme);
    void result.catch(() => {
      if (diagrams.get(key) === result) {
        diagrams.delete(key);
      }
    });
  }
  diagrams.set(key, result);
  if (diagrams.size > CACHE_LIMIT) {
    diagrams.delete(diagrams.keys().next().value!);
  }
  return result;
}

class OpenClawMermaid extends OpenClawLitElement {
  @property({ attribute: false }) source = "";
  @state() private imageUrl = "";
  @state() private showSource = false;
  @state() private expanded = false;
  @state() private pending = false;
  @state() private failed = false;
  @state() private copyResult: boolean | undefined;
  @state() private svgMarkup = "";
  @state() private zoom = 1;
  @state() private panX = 0;
  @state() private panY = 0;
  private dragging = false;
  private dragStartX = 0;
  private dragStartY = 0;
  private renderKey = "";
  private generation = 0;
  private copyAttempt = 0;
  private readonly themeObserver = new MutationObserver(() => void this.renderDiagram());

  static override styles = css`
    :host {
      display: block;
      position: relative;
      min-width: 0;
      margin: 12px 0;
      border: 1px solid var(--border);
      border-radius: var(--radius-md, 10px);
      overflow: hidden;
      background: var(--card);
      color: var(--text);
      font-family: var(--font-body);
    }
    .actions {
      position: absolute;
      inset-block-start: 6px;
      inset-inline-end: 6px;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      min-height: 42px;
      padding: 0 8px;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--text) 8%, transparent);
    }
    .toolbar .spacer {
      flex: 1;
    }
    .toolbar button {
      width: auto;
      padding: 0 8px;
      gap: 5px;
    }
    .toolbar button.active {
      background: color-mix(in srgb, var(--text) 16%, transparent);
      color: var(--text);
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: var(--radius-sm, 6px);
      background: transparent;
      color: var(--muted);
      font: inherit;
      cursor: default;
    }
    button:hover,
    button[aria-expanded="true"] {
      background: var(--bg-hover);
      color: var(--text);
    }
    button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    button svg {
      width: 15px;
      height: 15px;
    }
    .copy-button {
      opacity: 0;
      pointer-events: none;
    }
    :host(:hover) .copy-button,
    :host(:focus-within) .copy-button {
      opacity: 1;
      pointer-events: auto;
    }
    .copy-feedback {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
    wa-dropdown::part(menu) {
      min-width: 160px;
      padding: var(--menu-padding);
      border: 1px solid var(--overlay-border);
      border-radius: var(--menu-radius);
      background: var(--bg-elevated);
      box-shadow: var(--overlay-shadow);
    }
    wa-dropdown-item {
      min-height: var(--menu-item-height);
      padding: 0 8px;
      border-radius: var(--menu-item-radius);
      color: var(--text);
      font: 12px var(--font-body);
      cursor: default;
    }
    wa-dropdown-item:hover,
    wa-dropdown-item:focus-visible {
      background: var(--bg-hover);
    }
    .preview {
      height: 420px;
      padding: 16px;
      overflow: auto;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      cursor: grab;
      touch-action: none;
    }
    .preview:active {
      cursor: grabbing;
    }
    img {
      display: block;
      width: 100%;
      max-height: 480px;
      object-fit: contain;
      transform-origin: top left;
      user-select: none;
      pointer-events: none;
    }
    pre code { color: var(--text); }
    pre {
      margin: 0;
      padding: 36px 16px 16px;
      overflow: auto;
      max-height: 480px;
      font: 12px/1.6 var(--mono);
      tab-size: 2;
    }
    .status {
      margin: 0;
      padding: 36px 16px 12px;
      font-size: 12px;
      color: var(--muted);
    }
    @media (hover: none), (pointer: coarse) {
      button {
        width: 36px;
        height: 36px;
      }
      .copy-button {
        opacity: 1;
        pointer-events: auto;
      }
      .preview,
      pre,
      .status {
        padding-top: 44px;
      }
    }
  `;

  override connectedCallback() {
    super.connectedCallback();
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-theme-mode", "style"],
    });
    if (this.hasUpdated) {
      void this.renderDiagram();
    }
  }

  override disconnectedCallback() {
    this.themeObserver.disconnect();
    this.generation += 1;
    this.copyAttempt += 1;
    this.renderKey = "";
    this.expanded = false;
    this.releaseImage();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (changed.has("source")) {
      this.copyResult = undefined;
      this.copyAttempt += 1;
      this.releaseImage();
      this.svgMarkup = "";
      this.resetView();
      void this.renderDiagram();
    }
  }

  private releaseImage() {
    if (this.imageUrl) {
      URL.revokeObjectURL(this.imageUrl);
      this.imageUrl = "";
    }
  }

  private resetView() {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
  }

  private zoomAt(delta: number, event?: MouseEvent) {
    const preview = this.shadowRoot?.querySelector<HTMLElement>(".preview");
    const oldZoom = this.zoom;
    const nextZoom = Math.max(0.5, Math.min(3, oldZoom + delta));
    const rect = preview?.getBoundingClientRect();
    const x = event && rect ? event.clientX - rect.left : (rect?.width ?? 0) / 2;
    const y = event && rect ? event.clientY - rect.top : (rect?.height ?? 0) / 2;
    this.panX = x - (x - this.panX) * nextZoom / oldZoom;
    this.panY = y - (y - this.panY) * nextZoom / oldZoom;
    this.zoom = nextZoom;
  }

  private startPan(event: PointerEvent) {
    this.dragging = true;
    this.dragStartX = event.clientX - this.panX;
    this.dragStartY = event.clientY - this.panY;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  private movePan(event: PointerEvent) {
    if (!this.dragging) return;
    this.panX = event.clientX - this.dragStartX;
    this.panY = event.clientY - this.dragStartY;
    event.preventDefault();
  }

  private stopPan() {
    this.dragging = false;
  }

  private async saveBlob(blob: Blob, filename: string) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  private download(type: string) {
    if (!this.svgMarkup) return;
    if (type === "code") {
      void this.saveBlob(
        new Blob([this.source], { type: "text/plain;charset=utf-8" }),
        "diagram.svg",
      );
      return;
    }
    if (type === "svg") {
      void this.saveBlob(new Blob([this.svgMarkup], { type: "image/svg+xml" }), "diagram.svg");
      return;
    }
    const image = new Image();
    image.onload = () => {
      const svg = this.shadowRoot?.querySelector("img");
      const width = svg?.naturalWidth || 1200;
      const height = svg?.naturalHeight || 800;
      const canvas = document.createElement("canvas");
      canvas.width = width * 2;
      canvas.height = height * 2;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.fillStyle = getComputedStyle(this).backgroundColor || "#181818";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (blob) void this.saveBlob(blob, "diagram.png");
        },
        "image/png",
      );
    };
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(this.svgMarkup)}`;
  }

  private async renderDiagram() {
    if (!this.isConnected) {
      return;
    }
    const theme = currentTheme();
    const key = JSON.stringify([this.source, theme]);
    if (key === this.renderKey) {
      return;
    }
    this.renderKey = key;
    const generation = ++this.generation;
    this.pending = true;
    this.failed = false;
    try {
      const svg = isSvgSource(this.source)
        ? sanitizeSvgSource(this.source)
        : await cachedDiagram(key, this.source, theme);
      // Remounts, edits and theme switches can overtake asynchronous layout.
      // Only the current connected owner may acquire a new blob URL.
      if (!this.isConnected || generation !== this.generation) {
        return;
      }
      this.releaseImage();
      this.svgMarkup = svg;
      this.imageUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    } catch {
      if (this.isConnected && generation === this.generation) {
        this.releaseImage();
        this.failed = true;
      }
    } finally {
      if (this.isConnected && generation === this.generation) {
        this.pending = false;
      }
    }
  }

  private async copySource() {
    const attempt = ++this.copyAttempt;
    const copied = await copyToClipboard(this.source);
    if (this.isConnected && attempt === this.copyAttempt) {
      this.copyResult = copied;
    }
  }

  override render() {
    const sourceVisible = this.showSource || this.failed;
    const copyLabel = t(
      this.copyResult === undefined
        ? "chat.mermaid.copySource"
        : this.copyResult
          ? "common.copied"
          : "common.copyFailed",
    );
    return html`
      <div class="toolbar">
        <button
          class=${sourceVisible ? "" : "active"}
          type="button"
          aria-label=${t("chat.mermaid.diagram")}
          @click=${() => (this.showSource = false)}
        >${icons.image}${t("chat.mermaid.diagram")}</button>
        <button
          class=${sourceVisible ? "active" : ""}
          type="button"
          aria-label=${t("chat.mermaid.source")}
          @click=${() => (this.showSource = true)}
        >${icons.fileCode}${t("chat.mermaid.source")}</button>
        <span class="spacer"></span>
        <button
          type="button"
          aria-label=${t("chat.imageLightbox.zoomOut")}
          @click=${() => this.zoomAt(-0.2)}
        >${icons.minus}</button>
        <button
          type="button"
          aria-label=${t("chat.imageLightbox.zoomIn")}
          @click=${() => this.zoomAt(0.2)}
        >${icons.plus}</button>
        <button type="button" aria-label=${t("chat.imageLightbox.resetZoom")} @click=${() => this.resetView()}>${icons.refresh}</button>
        <wa-dropdown
          placement="bottom-end"
          size="s"
          .distance=${4}
          aria-label=${t("chat.imageLightbox.download")}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) =>
            this.download(event.detail.item.value ?? "svg")}
        >
          <button slot="trigger" type="button" aria-label=${t("chat.imageLightbox.download")}>
            ${icons.download}${t("chat.imageLightbox.download")}
          </button>
          <wa-dropdown-item value="png">PNG</wa-dropdown-item>
          <wa-dropdown-item value="svg">SVG</wa-dropdown-item>
          <wa-dropdown-item value="code">Code</wa-dropdown-item>
        </wa-dropdown>
        <button
          type="button"
          aria-label=${t("desktop.enterFullscreen")}
          @click=${() => (this.expanded = true)}
        >${icons.maximize}${t("desktop.enterFullscreen")}</button>
      </div>
      <div class="actions">
        <button
          class="copy-button"
          type="button"
          aria-label=${copyLabel}
          title=${copyLabel}
          @click=${() => void this.copySource()}
        >
          <span aria-hidden="true"
            >${
              this.copyResult === undefined ? icons.copy : this.copyResult ? icons.check : icons.x
            }</span
          >
        </button>
        <wa-dropdown
          placement="bottom-end"
          size="s"
          .distance=${4}
          aria-label=${t("chat.mermaid.options")}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            const action = event.detail.item.value;
            if (action === "expand") {
              this.expanded = true;
            } else if (action === "source" || action === "diagram") {
              this.showSource = action === "source";
            }
          }}
        >
          <button
            slot="trigger"
            type="button"
            aria-label=${t("chat.mermaid.options")}
            title=${t("chat.mermaid.options")}
          >
            <span aria-hidden="true">${icons.moreHorizontal}</span>
          </button>
          <wa-dropdown-item
            value=${sourceVisible ? "diagram" : "source"}
            ?disabled=${sourceVisible && !this.imageUrl}
            >${t(sourceVisible ? "chat.mermaid.diagram" : "chat.mermaid.source")}</wa-dropdown-item
          >
          <wa-dropdown-item value="expand" ?disabled=${!this.imageUrl}
            >${t("chat.mermaid.expand")}</wa-dropdown-item
          >
        </wa-dropdown>
      </div>
      <span class="copy-feedback" aria-live="polite"
        >${this.copyResult === undefined ? nothing : copyLabel}</span
      >
      ${
        this.failed
          ? html`<p class="status" role="status">${t("chat.mermaid.error")}</p>`
          : this.pending && !this.imageUrl
            ? html`<p class="status" role="status">${t("chat.mermaid.rendering")}</p>`
            : nothing
      }
      ${
        sourceVisible
          ? html`<pre><code>${unsafeHTML(
              highlightCodeHtml(this.source, isSvgSource(this.source) ? "xml" : ""),
            )}</code></pre>`
          : this.imageUrl
            ? html`<div
                class="preview"
                @pointerdown=${(event: PointerEvent) => this.startPan(event)}
                @pointermove=${(event: PointerEvent) => this.movePan(event)}
                @pointerup=${() => this.stopPan()}
                @pointercancel=${() => this.stopPan()}
                @dblclick=${(event: MouseEvent) => {
                  event.preventDefault();
                  this.zoomAt(this.zoom > 1 ? 1 - this.zoom : 0.4, event);
                }}
                @wheel=${(event: WheelEvent) => {
                  event.preventDefault();
                  this.zoomAt(event.deltaY < 0 ? 0.1 : -0.1, event as unknown as MouseEvent);
                }}
              >
                <img
                  src=${this.imageUrl}
                  alt=${t("chat.mermaid.title")}
                  style=${`transform: translate(${this.panX}px, ${this.panY}px) scale(${this.zoom});`}
                  @error=${() => {
                    this.failed = true;
                    this.releaseImage();
                  }}
                /></div>`
            : nothing
      }
      ${
        this.expanded && this.imageUrl
          ? html`<openclaw-image-lightbox
              src=${this.imageUrl}
              .imageTitle=${t("chat.mermaid.title")}
              @image-lightbox-close=${() => {
                this.expanded = false;
              }}
            ></openclaw-image-lightbox>`
          : nothing
      }
    `;
  }
}

if (!customElements.get("openclaw-mermaid")) {
  customElements.define("openclaw-mermaid", OpenClawMermaid);
}

export function mountMermaidBlocks(root: Element): boolean {
  let mounted = false;
  for (const block of root.querySelectorAll(".markdown-mermaid, .markdown-svg")) {
    const code = block.querySelector("pre code");
    if (!code) {
      continue;
    }
    const diagram = document.createElement("openclaw-mermaid");
    diagram.source = code.textContent ?? "";
    block.replaceChildren(diagram);
    mounted = true;
  }
  return mounted;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mermaid": OpenClawMermaid;
  }
}
