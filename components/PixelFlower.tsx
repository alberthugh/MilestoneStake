// An 8-bit pixel flower whose colour encodes a milestone's money state.
// green bloom = released · yellow bud = pending · red = late/penalized (wilts).
export default function PixelFlower({ state, size = 38 }: { state: "released" | "penalized" | "due" | "pending"; size?: number }) {
  const petal = state === "released" ? "#36e27b" : state === "penalized" ? "#ff5757" : "#ffd23e";
  const center = state === "penalized" ? "#7a1414" : "#7a4a17";
  const droop = state === "penalized";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" shapeRendering="crispEdges" style={{ transform: droop ? "rotate(8deg)" : undefined }} aria-hidden="true">
      <rect x="13" y="3" width="6" height="6" fill={petal} />
      <rect x="6" y="9" width="6" height="6" fill={petal} />
      <rect x="20" y="9" width="6" height="6" fill={petal} />
      <rect x="13" y="15" width="6" height="6" fill={petal} />
      <rect x="13" y="9" width="6" height="6" fill={center} />
      {state === "due" && <rect x="20" y="2" width="4" height="4" fill="#ff5757" />}
    </svg>
  );
}
