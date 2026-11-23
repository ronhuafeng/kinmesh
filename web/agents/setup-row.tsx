import type { ReactNode } from 'react';
import type { Step } from '../shared/t3.js';

export function Row({
  step,
  title,
  children,
}: {
  step: Step;
  title: string;
  children?: ReactNode;
}) {
  return (
    <li className="setup-step" data-step={step}>
      <span className="setup-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <span className="visually-hidden">
          {step === 'done'
            ? '（已完成）'
            : step === 'manual'
              ? '（在 Kinmesh 之外）'
              : '（待完成）'}
        </span>
        {children}
      </div>
    </li>
  );
}
