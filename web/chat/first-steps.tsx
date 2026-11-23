import type { WorkspaceSnapshot } from '../../src/workspace/contracts.js';
import { SettingsIcons } from '../shared/icons.js';

/**
 * A team's first steps, at the top of a channel until all are done: an
 * agent, T3 for it to run in, and a first message to it. Each says what is
 * left and has the one control that does it; what is done is checked.
 */
export function FirstSteps({
  data,
  openAgent,
  onTeam,
}: {
  data: WorkspaceSnapshot;
  openAgent: (id: string) => void;
  onTeam: () => void;
}) {
  const agent = data.agents[0];
  const steps = [
    {
      label: '添加一个智能体',
      done: agent !== undefined,
      action: { label: '添加', run: onTeam },
    },
    {
      label: agent ? `为 ${agent.name} 连接 T3` : '连接 T3，智能体在那里工作',
      done: data.nativeT3Origin !== null,
      action: agent
        ? {
            label: '连接',
            run: () => {
              openAgent(agent.id);
            },
          }
        : null,
    },
    {
      label: agent
        ? `在下面 @${agent.name}，请它做第一件事`
        : '在频道里 @ 它，请它做第一件事',
      done:
        data.deliveries.length > 0 ||
        data.messages.items.some((m) => m.author.kind === 'agent'),
      action: null,
    },
  ];
  if (steps.every((step) => step.done)) return null;
  return (
    <section className="first-steps" aria-label="开始使用">
      <h2>开始使用</h2>
      <ol>
        {steps.map((step, index) => (
          <li key={step.label} data-done={step.done ? 'true' : undefined}>
            <span className="first-step-mark" aria-hidden="true">
              {step.done ? <SettingsIcons.check size={16} /> : index + 1}
            </span>
            <span className="first-step-label">
              {step.label}
              {step.done && <span className="visually-hidden">（已完成）</span>}
            </span>
            {!step.done && step.action && (
              <button
                type="button"
                className="link-button"
                onClick={step.action.run}
              >
                {step.action.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
