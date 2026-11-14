/**
 * Unsplash API client (search, photo download). Follows Unsplash's API terms: every use
 * of a photo is registered through its download_location, and links carry UTM params.
 * The access key is a plugin secret and never leaves the server.
 */
import type { UnsplashPhoto } from "../shared/contract";

type RawPhoto = {
  id: string; color?: string; alt_description?: string | null; description?: string | null;
  width: number; height: number;
  urls: { raw: string };
  links: { html: string; download_location: string };
  user: { name: string; links: { html: string } };
};

const API = "https://api.unsplash.com";
const UTM = "utm_source=bb_calternal_frame&utm_medium=referral";
const withUtm = (url: string) => `${url}${url.includes("?") ? "&" : "?"}${UTM}`;

export function createUnsplash(accessKey: () => string) {
  async function call(path: string): Promise<unknown> {
    const key = accessKey();
    if (!key) throw new Error("Add an Unsplash access key in this plugin's settings first.");
    const response = await fetch(`${API}${path}`, {
      headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) return response.json();
    // Unsplash explains errors in the body ({"errors": [...]}); it never echoes the key.
    const body = (await response.text()).slice(0, 300);
    let detail = body;
    try { detail = (JSON.parse(body) as { errors?: string[] }).errors?.join(" ") ?? body; } catch { /* plain text */ }
    if (response.status === 401) throw new Error(`Unsplash rejected the access key: ${detail}`);
    if (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0") {
      throw new Error("Unsplash rate limit reached (50 requests an hour for demo apps); try again within the hour.");
    }
    throw new Error(`Unsplash returned HTTP ${response.status}: ${detail}`);
  }

  async function search(query: string, page: number): Promise<{ photos: UnsplashPhoto[]; totalPages: number }> {
    const body = await call(
      `/search/photos?query=${encodeURIComponent(query)}&page=${page}&per_page=24&orientation=landscape&content_filter=high`,
    ) as { total_pages: number; results: (RawPhoto & { urls: { small: string } })[] };
    return {
      totalPages: body.total_pages,
      photos: body.results.map((p) => ({
        id: p.id,
        thumb: p.urls.small,
        color: p.color ?? "#777",
        alt: p.alt_description ?? p.description ?? "",
        width: p.width,
        height: p.height,
        author: p.user.name,
        authorProfile: withUtm(p.user.links.html),
        photoPage: withUtm(p.links.html),
      })),
    };
  }

  async function fetchJpeg(url: string, timeout: number): Promise<string> {
    const image = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    if (!image.ok) throw new Error(`Unsplash image download failed (HTTP ${image.status}).`);
    return `data:image/jpeg;base64,${Buffer.from(await image.arrayBuffer()).toString("base64")}`;
  }

  /** Downloads a photo at 2560px plus a 480px thumbnail, and registers the download. */
  async function download(id: string) {
    const photo = await call(`/photos/${encodeURIComponent(id)}`) as RawPhoto;
    const location = new URL(photo.links.download_location);
    await call(location.pathname + location.search);
    const [data, thumb] = await Promise.all([
      fetchJpeg(`${photo.urls.raw}&w=2560&q=82&fm=jpg&fit=max`, 30_000),
      fetchJpeg(`${photo.urls.raw}&w=480&q=70&fm=jpg&fit=max`, 15_000).catch(() => null),
    ]);
    const credit = { name: photo.user.name, profile: withUtm(photo.user.links.html), photo: withUtm(photo.links.html) };
    return { data, thumb, credit };
  }

  return { search, download };
}
