import { Avatar } from '../shared/faces.js';
import { MemberMenu } from './menus.js';
import { Presence } from '../shared/faces.js';
import { type ReactElement } from 'react';
import { otherPeople } from '../shared/names.js';
import { workerConnected } from '../shared/format.js';
import { useNavigation, useScreen, useActions } from './contexts.js';

/** The others in the channel, people then agents; a row opens them. */
export function PeopleList() {
  const { agentId, view, setView, openAgent } = useNavigation();
  const { data, channel, channelPath, directWith, channelAgents } = useScreen();
  const { openDirect, removeMember } = useActions();
  /** A member's row in the open channel: its menu takes them out of it. */
  const memberRow = (
    member: { kind: 'human' | 'agent'; id: string },
    name: string,
    row: ReactElement,
  ) =>
    channel && channelPath ? (
      <MemberMenu
        channelName={channel.name}
        name={name}
        onRemove={() => {
          removeMember(member, name);
        }}
      >
        {row}
      </MemberMenu>
    ) : (
      row
    );
  return (
    <section className="people" aria-label={channel ? '本频道成员' : '成员'}>
      {/* A line, not a heading: what follows plainly belongs to
                      the channel above. */}
      <hr className="nav-separator" />
      <ul>
        {/* You know you are here: the list is the others. A
                        person has no page of their own: their row opens your
                        own conversation with them. */}
        {otherPeople(data).map((person) => (
          <li key={person.id}>
            {memberRow(
              { kind: 'human', id: person.id },
              person.name,
              // A person's face opens your own conversation.
              <button
                className="person"
                aria-pressed={
                  channel !== null && directWith.get(channel.id) === person.id
                }
                onClick={() => {
                  openDirect(person.id);
                }}
              >
                <Avatar
                  kind="human"
                  name={person.name}
                  id={person.id}
                  size="sm"
                />
                <span className="person-name">{person.name}</span>
                <Presence online={person.online} dot />
              </button>,
            )}
          </li>
        ))}
        {channelAgents.map((agent) => (
          <li key={agent.id}>
            {memberRow(
              { kind: 'agent', id: agent.id },
              agent.name,
              <button
                className="person"
                aria-pressed={view === 'agent' && agentId === agent.id}
                onClick={() => {
                  openAgent(agent.id);
                }}
              >
                <Avatar
                  kind="agent"
                  name={agent.name}
                  id={agent.id}
                  size="sm"
                />
                <span className="person-name">{agent.name}</span>
                <Presence online={workerConnected(data.wake, agent.id)} dot />
              </button>,
            )}
          </li>
        ))}
      </ul>
      {channel && channelAgents.length === 0 && (
        <button
          className="link-button"
          onClick={() => {
            setView('team');
          }}
        >
          添加智能体
        </button>
      )}
    </section>
  );
}
