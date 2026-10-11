/**
 * The wear layers for one worn sheet — four shading layers plus the light
 * model, stacked above the print (src/components/archive/paper-wear.css).
 * The sheet itself carries the data-* attributes from wearAttrs(); these
 * spans are inert paint. Always rendered in this order: mottle, edge,
 * folds, ear, light.
 */
export function PaperWearLayers() {
  return (
    <>
      <span className="paper-wear-mottle" aria-hidden="true" />
      <span className="paper-wear-edge" aria-hidden="true" />
      <span className="paper-wear-folds" aria-hidden="true" />
      <span className="paper-wear-ear" aria-hidden="true" />
      <span className="paper-wear-light" aria-hidden="true" />
    </>
  );
}
