import { useEffect, useRef, useState } from 'react';
import type { Coast, GameState, Order, TerritoryId, Unit } from '@diplomacy/shared';
import { POWER_COLORS, TERRITORY_BY_ID, territoryName } from '../lib/game.js';

interface Props {
  gameState: GameState | null;
  selectedTerritory: TerritoryId | null;
  validTargets: TerritoryId[];
  pendingOrders: Order[];
  onSelectTerritory: (territory: TerritoryId) => void;
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_TO_INTERNAL: Record<string, TerritoryId> = {
  mid: 'MAO',
  nat: 'NAO',
  nrg: 'NWG',
  nwy: 'NOR',
};
const INTERNAL_TO_SVG: Record<TerritoryId, string> = {
  MAO: 'mid',
  NAO: 'nat',
  NWG: 'nrg',
  NOR: 'nwy',
};
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.25;
const WHEEL_ZOOM_STEP = 0.1;

export function MapGraph({
  gameState,
  selectedTerritory,
  validTargets,
  pendingOrders,
  onSelectTerritory,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [markup, setMarkup] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/standard-map.svg', { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error(`Map request failed (${response.status})`);
        return response.text();
      })
      .then(setMarkup)
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoadError(error instanceof Error ? error.message : 'Unable to load map');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const svg = container?.querySelector('svg');
    if (!container || !svg || !markup) return;

    svg.classList.add('diplomacy-map');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Interactive Diplomacy board');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.querySelectorAll('title').forEach(title => title.remove());

    const provinces = svg.querySelector<SVGGElement>('#provinces');
    if (provinces) {
      provinces.style.display = 'inline';
      for (const shape of Array.from(provinces.children)) {
        if (!(shape instanceof SVGElement) || !shape.id) continue;
        if (shape.id.includes('/')) {
          shape.style.pointerEvents = 'none';
          continue;
        }
        const territory = toInternalTerritory(shape.id);
        const definition = TERRITORY_BY_ID[territory];
        if (!definition) continue;

        const territoryState = gameState?.territories[territory];
        const color = territoryState?.owner
          ? POWER_COLORS[territoryState.owner]
          : definition.type === 'SEA'
            ? '#32647d'
            : '#b5a98e';

        shape.dataset.territory = territory;
        shape.classList.add('province-shape');
        shape.classList.toggle('selected', territory === selectedTerritory);
        shape.classList.toggle('valid-target', validTargets.includes(territory));
        shape.style.setProperty('fill', color, 'important');
        shape.style.setProperty(
          'fill-opacity',
          definition.type === 'SEA' ? '0.32' : territoryState?.owner ? '0.64' : '0.46',
          'important'
        );
        shape.style.setProperty('stroke', '#17232b', 'important');
        shape.style.setProperty('stroke-width', '1.4', 'important');
      }
    }

    const supplyCenters = svg.querySelector<SVGGElement>('#supply-centers');
    if (supplyCenters) {
      supplyCenters.style.display = 'inline';
      supplyCenters.style.pointerEvents = 'none';
    }

    const names = svg.querySelector<SVGGElement>('#names');
    if (names) names.style.pointerEvents = 'none';

    const provinceCenters = svg.querySelector<SVGGElement>('#province-centers');
    if (provinceCenters) {
      provinceCenters.style.display = 'inline';
      provinceCenters.style.visibility = 'hidden';
    }

    renderUnits(svg, gameState?.units ?? []);
    renderOrders(svg, pendingOrders);

    const handleClick = (event: Event) => {
      if (suppressClickRef.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) return;
      const province = target.closest<SVGElement>('[data-territory]');
      const territory = province?.dataset.territory;
      if (territory) onSelectTerritory(territory);
    };
    svg.addEventListener('click', handleClick);
    return () => svg.removeEventListener('click', handleClick);
  }, [
    gameState,
    markup,
    onSelectTerritory,
    pendingOrders,
    selectedTerritory,
    validTargets,
  ]);

  if (loadError) {
    return <div className="map-message">Map unavailable: {loadError}</div>;
  }
  if (!markup) {
    return <div className="map-message">Loading board...</div>;
  }

  function changeZoom(delta: number) {
    setZoom(current => clampZoom(current + delta));
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    const container = containerRef.current;
    if (!container || event.deltaY === 0) return;
    event.preventDefault();

    const nextZoom = clampZoom(
      zoom + (event.deltaY < 0 ? WHEEL_ZOOM_STEP : -WHEEL_ZOOM_STEP)
    );
    if (nextZoom === zoom) return;

    const bounds = container.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left;
    const pointerY = event.clientY - bounds.top;
    const contentX = container.scrollLeft + pointerX;
    const contentY = container.scrollTop + pointerY;
    const ratio = nextZoom / zoom;

    setZoom(nextZoom);
    requestAnimationFrame(() => {
      container.scrollLeft = contentX * ratio - pointerX;
      container.scrollTop = contentY * ratio - pointerY;
    });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const container = containerRef.current;
    if (!container) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: container.scrollLeft,
      scrollTop: container.scrollTop,
      moved: false,
    };
    container.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || !container || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) {
      drag.moved = true;
      container.classList.add('dragging');
    }
    if (!drag.moved) return;
    container.scrollLeft = drag.scrollLeft - dx;
    container.scrollTop = drag.scrollTop - dy;
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const container = containerRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    container?.classList.remove('dragging');
    if (container?.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }
  }

  return (
    <div className="map-frame">
      <div className="map-controls" aria-label="Map zoom controls">
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => changeZoom(-ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM}
        >
          -
        </button>
        <button type="button" onClick={() => setZoom(1)} aria-label="Reset map zoom">
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => changeZoom(ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM}
        >
          +
        </button>
      </div>
      {pendingOrders.length > 0 && (
        <div className="order-legend" aria-label="Order symbols">
          <span><i className="legend-hold" /> Hold</span>
          <span><i className="legend-move" /> Move</span>
          <span><i className="legend-support" /> Support</span>
          <span><i className="legend-convoy" /> Convoy</span>
        </div>
      )}
      <div
        className="map-viewport"
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onWheel={handleWheel}
      >
        <div
          className="map-canvas"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
          dangerouslySetInnerHTML={{ __html: markup }}
        />
      </div>
    </div>
  );
}

function renderUnits(svg: SVGSVGElement, units: Unit[]): void {
  const layer = svg.querySelector<SVGGElement>('#units');
  if (!layer) return;
  layer.replaceChildren();

  for (const unit of units) {
    const anchorId = `${unitAnchor(unit)}Center`;
    const anchor = svg.getElementById(anchorId);
    if (!(anchor instanceof SVGGraphicsElement)) continue;
    const box = anchor.getBBox();
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;

    const marker = document.createElementNS(SVG_NAMESPACE, 'g');
    marker.classList.add('unit-marker');
    if (unit.mustRetreat) marker.classList.add('must-retreat');
    marker.setAttribute('transform', `translate(${x} ${y})`);
    marker.style.setProperty('--unit-color', POWER_COLORS[unit.power]);
    marker.setAttribute(
      'aria-label',
      `${unit.power} ${unit.type.toLowerCase()} in ${territoryName(unit.territory)}`
    );

    const body = document.createElementNS(SVG_NAMESPACE, 'rect');
    body.setAttribute('x', '-18');
    body.setAttribute('y', '-13');
    body.setAttribute('width', '36');
    body.setAttribute('height', '26');
    body.setAttribute('rx', unit.type === 'FLEET' ? '13' : '5');

    const label = document.createElementNS(SVG_NAMESPACE, 'text');
    label.setAttribute('x', '0');
    label.setAttribute('y', '6');
    label.textContent = unit.type === 'FLEET' ? 'F' : 'A';

    marker.append(body, label);
    layer.append(marker);
  }
}

function renderOrders(svg: SVGSVGElement, orders: Order[]): void {
  const layer = svg.querySelector<SVGGElement>('#orders');
  if (!layer) return;
  layer.replaceChildren();

  for (const order of orders) {
    const source = territoryCenter(svg, order.unitTerritory, order.unitCoast);
    if (!source) continue;
    const color = POWER_COLORS[order.power];

    if (order.type === 'HOLD') {
      drawOrderRing(layer, source, color, 'H');
      continue;
    }

    if (order.type === 'MOVE' && order.targetTerritory) {
      const target = territoryCenter(svg, order.targetTerritory, order.targetCoast);
      if (target) drawOrderArrow(layer, source, target, color, 'move');
      continue;
    }

    if (order.type === 'SUPPORT_HOLD' && order.supportedUnit) {
      const supported = territoryCenter(svg, order.supportedUnit, null);
      if (supported) {
        drawOrderArrow(layer, source, supported, color, 'support-hold', false);
        drawOrderRing(layer, supported, color, 'S', 24);
      }
      continue;
    }

    if (order.type === 'SUPPORT_MOVE' && order.supportedDestination) {
      const destination = territoryCenter(svg, order.supportedDestination, null);
      if (destination) {
        drawOrderArrow(layer, source, destination, color, 'support-move');
        drawOrderBadge(layer, source, 'S');
      }
      continue;
    }

    if (order.type === 'CONVOY' && order.supportedUnit && order.targetTerritory) {
      const army = territoryCenter(svg, order.supportedUnit, null);
      const destination = territoryCenter(svg, order.targetTerritory, null);
      if (army && destination) {
        drawOrderArrow(layer, army, source, color, 'convoy', false);
        drawOrderArrow(layer, source, destination, color, 'convoy');
        drawOrderBadge(layer, source, 'C');
      }
    }
  }
}

function drawOrderArrow(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: 'move' | 'support-hold' | 'support-move' | 'convoy',
  arrow = true
): void {
  const shortened = shortenLine(source, target, 22, arrow ? 20 : 22);
  let lineEnd = shortened.end;
  if (arrow) {
    const dx = shortened.end.x - shortened.start.x;
    const dy = shortened.end.y - shortened.start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const arrowLength = 18;
    lineEnd = {
      x: shortened.end.x - dx / distance * (arrowLength - 1),
      y: shortened.end.y - dy / distance * (arrowLength - 1),
    };
  }
  drawOrderLine(layer, shortened.start, lineEnd, color, kind, true);
  drawOrderLine(layer, shortened.start, lineEnd, color, kind, false);
  if (arrow) drawArrowHead(layer, shortened.start, shortened.end, color, kind);
}

function drawOrderLine(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: 'move' | 'support-hold' | 'support-move' | 'convoy',
  outline: boolean
): void {
  const line = document.createElementNS(SVG_NAMESPACE, 'line');
  line.classList.add(outline ? 'order-path-outline' : 'order-path', `order-${kind}`);
  line.setAttribute('x1', String(source.x));
  line.setAttribute('y1', String(source.y));
  line.setAttribute('x2', String(target.x));
  line.setAttribute('y2', String(target.y));
  line.style.setProperty('--order-color', color);
  layer.append(line);
}

function drawArrowHead(
  layer: SVGGElement,
  source: Point,
  target: Point,
  color: string,
  kind: string
): void {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const length = 18;
  const width = 10;
  const back = {
    x: target.x - Math.cos(angle) * length,
    y: target.y - Math.sin(angle) * length,
  };
  const points = [
    target,
    {
      x: back.x + Math.cos(angle + Math.PI / 2) * width,
      y: back.y + Math.sin(angle + Math.PI / 2) * width,
    },
    {
      x: back.x + Math.cos(angle - Math.PI / 2) * width,
      y: back.y + Math.sin(angle - Math.PI / 2) * width,
    },
  ];
  const head = document.createElementNS(SVG_NAMESPACE, 'polygon');
  head.classList.add('order-arrowhead', `order-${kind}`);
  head.setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
  head.style.setProperty('--order-color', color);
  layer.append(head);
}

function drawOrderRing(
  layer: SVGGElement,
  center: Point,
  color: string,
  label: string,
  radius = 27
): void {
  const ring = document.createElementNS(SVG_NAMESPACE, 'circle');
  ring.classList.add('order-ring');
  ring.setAttribute('cx', String(center.x));
  ring.setAttribute('cy', String(center.y));
  ring.setAttribute('r', String(radius));
  ring.style.setProperty('--order-color', color);
  layer.append(ring);
  drawOrderBadge(layer, center, label);
}

function drawOrderBadge(layer: SVGGElement, center: Point, label: string): void {
  const badge = document.createElementNS(SVG_NAMESPACE, 'text');
  badge.classList.add('order-badge');
  badge.setAttribute('x', String(center.x));
  badge.setAttribute('y', String(center.y - 24));
  badge.textContent = label;
  layer.append(badge);
}

interface Point {
  x: number;
  y: number;
}

function territoryCenter(
  svg: SVGSVGElement,
  territory: TerritoryId,
  coast: Coast | null
): Point | null {
  const province = INTERNAL_TO_SVG[territory] ?? territory.toLowerCase();
  const coastSuffix = coast ? `/${{
    NORTH: 'nc',
    SOUTH: 'sc',
    EAST: 'ec',
    WEST: 'wc',
  }[coast]}` : '';
  const anchor =
    svg.getElementById(`${province}${coastSuffix}Center`) ??
    svg.getElementById(`${province}Center`);
  if (!(anchor instanceof SVGGraphicsElement)) return null;
  const box = anchor.getBBox();
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
}

function shortenLine(
  source: Point,
  target: Point,
  sourcePadding: number,
  targetPadding: number
): { start: Point; end: Point } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy) || 1;
  return {
    start: {
      x: source.x + dx / distance * sourcePadding,
      y: source.y + dy / distance * sourcePadding,
    },
    end: {
      x: target.x - dx / distance * targetPadding,
      y: target.y - dy / distance * targetPadding,
    },
  };
}

function unitAnchor(unit: Unit): string {
  const province = INTERNAL_TO_SVG[unit.territory] ?? unit.territory.toLowerCase();
  if (!unit.coast) return province;
  const coast = {
    NORTH: 'nc',
    SOUTH: 'sc',
    EAST: 'ec',
    WEST: 'wc',
  }[unit.coast];
  return `${province}/${coast}`;
}

function toInternalTerritory(svgId: string): TerritoryId {
  return SVG_TO_INTERNAL[svgId] ?? svgId.toUpperCase();
}

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}
