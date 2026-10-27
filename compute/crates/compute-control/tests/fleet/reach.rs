//! Private destinations hosts offer: a sandbox that asks to reach one goes
//! only to a host that offers it, and only when its team may.

use std::collections::{BTreeMap, BTreeSet};

use compute_protocol::host::Request;
use serde_json::json;

use super::support::{Fleet, OTHER_KEY, TEAM};

async fn fleet() -> Fleet {
    Fleet::start_with(None, |settings| {
        settings.reach = BTreeMap::from([(
            TEAM.to_owned(),
            BTreeSet::from(["previews".to_owned(), "unoffered".to_owned()]),
        )]);
    })
    .await
}

fn asking(reach: &[&str]) -> serde_json::Value {
    json!({ "vcpus": 1, "memory_mib": 256, "reach": reach })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_sandbox_reaching_an_offer_goes_only_to_a_host_that_offers_it() {
    let fleet = fleet().await;
    let plain = fleet.host("host-a.example").await;
    let offering = fleet
        .host_offering("host-b.example", &["builds", "previews"])
        .await;
    for _ in 0..4 {
        let (status, row) = fleet
            .post("/v1/sandboxes", asking(&["previews", "previews"]))
            .await;
        assert_eq!(status, 201, "{row}");
        assert_eq!(row["host"], "host-b.example", "{row}");
        assert_eq!(row["config"]["reach"], json!(["previews"]), "{row}");
    }
    for seen in offering.seen() {
        if let Request::Create { config, .. } = &seen.envelope.request {
            assert_eq!(config.reach, ["previews"]);
        }
    }
    assert!(!plain.ops().contains(&"create"), "{:?}", plain.ops());
    // One that asks for nothing goes anywhere, and its row says nothing of
    // reach.
    let (status, row) = fleet.post("/v1/sandboxes", asking(&[])).await;
    assert_eq!(status, 201, "{row}");
    assert!(row["config"].get("reach").is_none(), "{row}");

    // A sandbox moved by name goes only to a host that offers what it
    // reaches.
    let (_, list) = fleet.get("/v1/sandboxes").await;
    let reaching = list
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["config"]["reach"] == json!(["previews"]))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, body) = fleet
        .post(
            &format!("/v1/sandboxes/{reaching}/move"),
            json!({ "to": "host-a.example" }),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(
        body.to_string().contains("does not offer \\\"previews\\\""),
        "{body}"
    );
    assert!(
        !offering.ops().contains(&"hand_off"),
        "{:?}",
        offering.ops()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reach_a_team_was_not_given_or_no_host_offers_is_refused_before_any_host_is_asked() {
    let fleet = fleet().await;
    let offering = fleet.host_offering("host-b.example", &["previews"]).await;

    // Not given to the team, though a host offers it.
    let (status, body) = fleet
        .call(
            reqwest::Method::POST,
            "/v1/sandboxes",
            Some(OTHER_KEY),
            Some(asking(&["previews"])),
        )
        .await;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("may not reach"), "{body}");
    let (status, body) = fleet.post("/v1/sandboxes", asking(&["builds"])).await;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("may not reach"), "{body}");

    // Not a name at all.
    let (status, body) = fleet.post("/v1/sandboxes", asking(&["Previews"])).await;
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("not an offer's name"), "{body}");

    // Given, but no host offers it now.
    let (status, body) = fleet.post("/v1/sandboxes", asking(&["unoffered"])).await;
    assert_eq!(status, 503, "{body}");
    assert!(body.to_string().contains("no host offers"), "{body}");

    assert!(offering.ops().is_empty(), "{:?}", offering.ops());
    let (_, list) = fleet.get("/v1/sandboxes").await;
    assert_eq!(list, json!([]), "{list}");
}
