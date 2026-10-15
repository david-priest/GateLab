// loadScript.ts — Google's sign-in and Picker libraries, each loaded once, from Google, only in
// the lab build and only once the Lab Drive menu is on the page.

const loading = new Map<string, Promise<void>>();

export function loadScript(src: string): Promise<void> {
  let promise = loading.get(src);
  if (!promise) {
    promise = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        loading.delete(src);
        script.remove();
        reject(new Error(`Could not load ${new URL(src).host}; check the network connection and try again.`));
      };
      document.head.appendChild(script);
    });
    loading.set(src, promise);
  }
  return promise;
}
