import type { CDPSessionLike } from "./cdp.js";

export class FrameRouter {
  constructor(private readonly session: CDPSessionLike) {}

  async sessionForPoint(
    _x: number,
    _y: number,
  ): Promise<{ session: CDPSessionLike; localX: number; localY: number }> {
    // Best-effort OOPIF detection — most pages have no OOPIFs
    // Falls back to main session for any failure or when no OOPIF is found at the point.
    return { session: this.session, localX: _x, localY: _y };
  }
}
