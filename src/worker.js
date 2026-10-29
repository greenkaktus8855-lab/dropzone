
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/.netlify/functions/game") {
      const target = new URL(
        "https://chic-ganache-38ae89.netlify.app/.netlify/functions/game"
      );

      target.search = url.search;

      const headers = new Headers(request.headers);
      headers.set("Host", target.host);

      return fetch(
        new Request(target.toString(), {
          method: request.method,
          headers,
          body: ["GET", "HEAD"].includes(request.method)
            ? undefined
            : request.body,
          redirect: "follow"
        })
      );
    }

    return env.ASSETS.fetch(request);
  }
};
