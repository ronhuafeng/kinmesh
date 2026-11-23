import { Component } from 'react';
import type { ReactNode } from 'react';
import { Broken } from './broken.js';

/** Anything that throws while drawing the workspace shows the way back. */
export class Boundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <Broken /> : this.props.children;
  }
}
