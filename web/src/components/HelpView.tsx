import { useEffect, useMemo, useState } from 'react';
import { HELP_TOPICS, type HelpTopicId } from '../content/help';

export interface HelpViewProps {
  activeTopic?: HelpTopicId;
  onTopicVisible?: (topic: HelpTopicId) => void;
}

export function HelpView({ activeTopic, onTopicVisible }: HelpViewProps) {
  const [selectedTopic, setSelectedTopic] = useState<HelpTopicId>(activeTopic ?? HELP_TOPICS[0].id);

  useEffect(() => {
    if (activeTopic) setSelectedTopic(activeTopic);
  }, [activeTopic]);

  useEffect(() => {
    const element = document.getElementById(`help-${selectedTopic}`);
    element?.scrollIntoView({ block: 'start' });
    onTopicVisible?.(selectedTopic);
  }, [selectedTopic, onTopicVisible]);

  const selected = useMemo(() => HELP_TOPICS.find((topic) => topic.id === selectedTopic) ?? HELP_TOPICS[0], [selectedTopic]);

  return (
    <div className="help-view">
      <section className="panel help-hero">
        <p className="eyebrow">Help</p>
        <h1>Guida operativa</h1>
        <p className="muted">
          Una guida pratica per usare Agent Control senza conoscere i dettagli interni.
          I contenuti sono condivisi da questa pagina e dai link contestuali nelle schermate.
        </p>
      </section>

      <div className="help-layout">
        <aside className="panel help-index" aria-label="Argomenti Help">
          <h2>Argomenti</h2>
          {HELP_TOPICS.map((topic) => (
            <button
              key={topic.id}
              type="button"
              className={`help-topic-button ${topic.id === selected.id ? 'active' : ''}`}
              onClick={() => setSelectedTopic(topic.id)}
              aria-current={topic.id === selected.id ? 'true' : undefined}
            >
              <strong>{topic.title}</strong>
              <span>{topic.summary}</span>
            </button>
          ))}
        </aside>

        <section className="help-topics" aria-label="Contenuti Help">
          {HELP_TOPICS.map((topic) => (
            <article className="panel help-topic" id={`help-${topic.id}`} key={topic.id}>
              <p className="eyebrow">{topic.id.replace(/-/g, ' ')}</p>
              <h2>{topic.title}</h2>
              <p className="muted">{topic.summary}</p>
              <ul>
                {topic.body.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
