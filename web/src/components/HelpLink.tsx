import type { ReactNode } from 'react';
import type { HelpTopicId } from '../content/help';

export interface HelpLinkProps {
  topic: HelpTopicId;
  onOpenHelp: (topic: HelpTopicId) => void;
  children?: ReactNode;
  tone?: 'link' | 'chip';
}

export function HelpLink({ topic, onOpenHelp, children, tone = 'link' }: HelpLinkProps) {
  return (
    <button type="button" className={`help-link help-link-${tone}`} onClick={() => onOpenHelp(topic)}>
      <span aria-hidden="true">?</span>
      <span>{children ?? 'Aiuto'}</span>
    </button>
  );
}

export function InlineHelp({ topic, onOpenHelp, children }: HelpLinkProps) {
  return (
    <p className="inline-help">
      {children}
      <HelpLink topic={topic} onOpenHelp={onOpenHelp} />
    </p>
  );
}
