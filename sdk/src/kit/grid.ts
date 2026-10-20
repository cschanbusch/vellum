// <vellum-grid>: a virtualized grid of covers sized by --v-cover-width.

import { css } from "lit";
import type { Direction } from "../focus-math";
import { CoverCollection } from "./collection";

export class VellumGrid extends CoverCollection {
  private cols = 1;
  private offsetX = 0;

  protected measure() {
    super.measure();
    const inner = Math.max(0, this.viewportW - this.pad * 2);
    this.cols = Math.max(1, Math.floor((inner + this.gap) / (this.cellWidth + this.gap)));
    const used = this.cols * this.cellWidth + (this.cols - 1) * this.gap;
    this.offsetX = Math.max(this.pad, (this.viewportW - used) / 2);
  }

  private get rows() {
    return Math.ceil(this.entries.length / this.cols);
  }

  protected contentSize() {
    const rows = this.rows;
    return { w: 1, h: rows ? this.pad * 2 + rows * this.rowHeight + (rows - 1) * this.gap : 0 };
  }

  protected position(i: number) {
    const row = Math.floor(i / this.cols);
    const col = i % this.cols;
    return { x: this.offsetX + col * (this.cellWidth + this.gap), y: this.pad + row * (this.rowHeight + this.gap) };
  }

  private get pitch() {
    return this.rowHeight + this.gap;
  }

  protected visibleRange(): [number, number] {
    // Two rows of overscan each way, so covers are already loading before they scroll in.
    const first = Math.max(0, Math.floor((this.scrollTop - this.pad) / this.pitch) - 2);
    const last = Math.ceil((this.scrollTop + this.viewportH) / this.pitch) + 2;
    return [first * this.cols, Math.min(this.entries.length, last * this.cols)];
  }

  private get rowsPerPage() {
    return Math.max(1, Math.floor(this.viewportH / this.pitch));
  }

  protected step(dir: Direction | "pageUp" | "pageDown" | "home" | "end", i: number): number {
    const n = this.entries.length;
    const c = this.cols;
    switch (dir) {
      case "left":
        return i % c === 0 ? -1 : i - 1;
      case "right":
        return i % c === c - 1 || i + 1 >= n ? -1 : i + 1;
      case "up":
        return i - c >= 0 ? i - c : -1;
      case "down":
        if (i + c < n) return i + c;
        // Into a shorter last row.
        return Math.floor(i / c) < this.rows - 1 ? n - 1 : -1;
      case "pageUp":
        return Math.max(i % c, i - c * this.rowsPerPage);
      case "pageDown": {
        const j = i + c * this.rowsPerPage;
        return j < n ? j : n - 1;
      }
      case "home":
        return 0;
      case "end":
        return n - 1;
    }
  }

  protected reveal(i: number, smooth: boolean) {
    const y = this.position(i).y;
    const margin = this.gap;
    let top = this.scrollTop;
    if (y - margin < top) top = y - margin;
    else if (y + this.rowHeight + margin > top + this.viewportH) top = y + this.rowHeight + margin - this.viewportH;
    if (top !== this.scrollTop) this.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  }

  static styles = [
    CoverCollection.styles,
    css`
      :host {
        overflow-x: hidden;
      }
    `,
  ];
}

customElements.define("vellum-grid", VellumGrid);
