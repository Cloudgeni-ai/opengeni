import { VISUALIZATION_CSS, VISUALIZATION_HELPERS } from "./visualization-assets.gen";

/** Conversation styling/helpers only. Rendering and tool transport remain in the Site frame. */
export function inlineHtmlDocument(fragment: string): string {
  return (
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    VISUALIZATION_CSS +
    "</style><style>html,body{margin:0;min-height:0}body{padding:16px;box-sizing:border-box}</style></head><body>" +
    fragment +
    VISUALIZATION_HELPERS +
    `<script>
(()=>{
  window.addEventListener('message',event=>{
    if(event.source!==parent||event.data?.type!=='opengeni.preview.theme')return;
    if(event.data.theme==='light'||event.data.theme==='dark')document.documentElement.style.colorScheme=event.data.theme;
    previous=0;resize();
  });
  let previous=0;
  const resize=()=>{const height=Math.ceil(document.body.getBoundingClientRect().height);if(height!==previous){previous=height;parent.postMessage({type:'opengeni.preview.height',height},'*')}};
  new ResizeObserver(resize).observe(document.body);resize();
})();
</script></body></html>`
  );
}
