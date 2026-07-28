import { describe, expect, test } from "bun:test";
import {
  mapRedditListing,
  mapRedditThread,
  mapXTweets,
  redditCommentFromApiJson,
  redditThingId,
} from "../src/integrations/social-api";

describe("mapXTweets", () => {
  test("joins expansions.users and public_metrics into normalized posts", () => {
    const posts = mapXTweets({
      data: [
        {
          id: "1801",
          text: "opengeni looks neat",
          author_id: "u9",
          conversation_id: "1800",
          created_at: "2026-07-26T10:00:00.000Z",
          public_metrics: { like_count: 3, reply_count: 1 },
        },
        { id: "bad" }, // missing text: dropped, not crashed
      ],
      includes: { users: [{ id: "u9", username: "jane_dev" }] },
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      id: "1801",
      provider: "x",
      url: "https://x.com/jane_dev/status/1801",
      author: "jane_dev",
      text: "opengeni looks neat",
      createdAt: "2026-07-26T10:00:00.000Z",
      metrics: { like_count: 3, reply_count: 1 },
      context: { conversationId: "1800" },
    });
  });

  test("falls back to the connection handle when expansions are absent", () => {
    const posts = mapXTweets({ data: [{ id: "1", text: "hi" }] }, "me_handle");
    expect(posts[0]!.author).toBe("me_handle");
  });
});

describe("mapRedditListing", () => {
  test("maps t3 links (title + selftext) and t1 comments (body)", () => {
    const posts = mapRedditListing({
      kind: "Listing",
      data: {
        children: [
          {
            kind: "t3",
            data: {
              name: "t3_abc",
              title: "Best agent platform?",
              selftext: "Looking for something self-hostable",
              author: "curious_dev",
              permalink: "/r/selfhosted/comments/abc/best/",
              created_utc: 1785060000,
              score: 42,
              num_comments: 7,
              subreddit: "selfhosted",
            },
          },
          {
            kind: "t1",
            data: {
              name: "t1_def",
              body: "have you tried opengeni",
              author: "helpful_user",
              created_utc: 1785061000,
              score: 5,
              subreddit: "selfhosted",
            },
          },
          { kind: "t3", data: { name: "t3_empty" } }, // no text: dropped
        ],
      },
    });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.id).toBe("t3_abc");
    expect(posts[0]!.text).toBe("Best agent platform?\n\nLooking for something self-hostable");
    expect(posts[0]!.url).toBe("https://www.reddit.com/r/selfhosted/comments/abc/best/");
    expect(posts[0]!.metrics).toEqual({ score: 42, comments: 7 });
    expect(posts[1]!.id).toBe("t1_def");
    expect(posts[1]!.context).toEqual({ kind: "t1", subreddit: "selfhosted" });
  });
});

describe("mapRedditThread", () => {
  test("flattens the [post, comments] tuple from /comments/{article}", () => {
    const listing = (children: unknown[]) => ({ kind: "Listing", data: { children } });
    const posts = mapRedditThread([
      listing([{ kind: "t3", data: { name: "t3_abc", title: "Post", selftext: "" } }]),
      listing([{ kind: "t1", data: { name: "t1_def", body: "First comment" } }]),
    ] as unknown as Record<string, unknown>);
    expect(posts.map((post) => post.id)).toEqual(["t3_abc", "t1_def"]);
  });
});

describe("redditThingId", () => {
  test("accepts fullnames and rejects bare ids", () => {
    expect(redditThingId("t3_abc12")).toBe("t3_abc12");
    expect(redditThingId("t1_zzz")).toBe("t1_zzz");
    expect(() => redditThingId("abc12")).toThrow("fullnames");
    expect(() => redditThingId("t9_bad")).toThrow("fullnames");
  });
});

describe("redditCommentFromApiJson", () => {
  test("extracts the created comment", () => {
    const result = redditCommentFromApiJson({
      json: {
        errors: [],
        data: {
          things: [
            { kind: "t1", data: { name: "t1_new", permalink: "/r/s/comments/a/_/t1_new/" } },
          ],
        },
      },
    });
    expect(result).toEqual({
      id: "t1_new",
      url: "https://www.reddit.com/r/s/comments/a/_/t1_new/",
    });
  });

  test("surfaces reddit api_type=json errors", () => {
    expect(() =>
      redditCommentFromApiJson({
        json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] },
      }),
    ).toThrow("RATELIMIT");
  });
});
