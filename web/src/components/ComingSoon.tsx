interface ComingSoonProps {
  title: string;
  description: string;
  phase?: string;
}

/**
 * Placeholder per le sezioni di navigazione previste dalla Control Room
 * (docs/ui/CONTROL_ROOM_SPEC.md §4, §23) la cui vista dedicata non è
 * ancora stata implementata. Fase 1 introduce solo shell/navigazione/
 * fondamenta responsive: le viste vere arriveranno nelle fasi successive.
 *
 * Non simula capacità non supportate (spec §22): comunica esplicitamente
 * che si tratta di un gap di implementazione pianificato.
 */
export function ComingSoon({ title, description, phase }: ComingSoonProps) {
  return (
    <div className="card coming-soon-card">
      <span className="coming-soon-badge">In arrivo</span>
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      {phase && <p className="muted small">Prevista nella fase: {phase}</p>}
    </div>
  );
}
