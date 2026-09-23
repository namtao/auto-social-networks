// Evaluated in the Facebook tab; resolves to [{text, link}] for the posts currently in the DOM.
// Deliberately "dumb": no author/ad/content parsing, the LLM does that from the raw text.
(async () => {
  const MIN_LEN = 40;
  const MAX_LEN = 6000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Several independent markers for a feed post; keep only the outermost match so
  // comments (also role="article") nested inside a post are not returned separately.
  const nodes = [...document.querySelectorAll('[role="feed"] > div, [aria-posinset], [role="article"]')];
  const matched = new Set(nodes);
  const posts = nodes.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (matched.has(p)) return false;
    return true;
  });

  // Expand truncated bodies and hover links (FB fills some permalink hrefs on hover).
  const MORE = /^(see more|xem thêm)$/i;
  for (const post of posts) {
    for (const btn of post.querySelectorAll('[role="button"]')) {
      if (MORE.test(btn.innerText.trim())) btn.click();
    }
    for (const a of post.querySelectorAll("a")) {
      a.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    }
  }
  await sleep(300 + Math.random() * 300);

  // Most specific first: a post permalink beats a video/reel link, which beats a photo link.
  const LINK_PREFERENCE = [
    /\/posts\/|\/permalink|story_fbid=|\/story\.php/,
    /\/(reel|videos)\/|\/watch\/\?v=/,
    /\/photo|fbid=/,
  ];
  const postLink = (post) => {
    const anchors = [...post.querySelectorAll("a[href]")].filter((a) => !a.href.includes("/hashtag/"));
    for (const re of LINK_PREFERENCE) {
      const a = anchors.find((x) => re.test(x.href));
      if (a) return a;
    }
    return null;
  };
  const cleanLink = (href) => {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("__")) url.searchParams.delete(key); // tracking params
    }
    return url.toString();
  };

  return posts
    .map((post) => {
      const a = postLink(post);
      return {
        text: post.innerText.trim().slice(0, MAX_LEN),
        link: a ? cleanLink(a.href) : null,
      };
    })
    .filter((p) => p.text.length >= MIN_LEN);
})()
