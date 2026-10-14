//! Runs the real `patchroom-claude dump` binary over a synthetic transcript that covers
//! every line shape the adapter knows. The transcript is built here from scratch: no
//! content from any real session is used.

use std::io::Write;
use std::process::Command;

use serde_json::{json, Value};

const BIN: &str = env!("CARGO_BIN_EXE_patchroom-claude");

fn ts(n: u32) -> String {
    format!("2026-01-01T00:00:{n:02}.000Z")
}

fn assistant(n: u32, blocks: Value) -> Value {
    json!({"type":"assistant","uuid":format!("a{n}"),"timestamp":ts(n),
           "message":{"role":"assistant","model":"m","content":blocks}})
}

fn user(n: u32, content: Value) -> Value {
    json!({"type":"user","uuid":format!("u{n}"),"timestamp":ts(n),
           "message":{"role":"user","content":content}})
}

fn result(n: u32, id: &str, content: Value, extra: Value) -> Value {
    let mut v = user(
        n,
        json!([{"type":"tool_result","tool_use_id":id,"content":content}]),
    );
    for (k, x) in extra.as_object().cloned().unwrap_or_default() {
        v[k] = x;
    }
    v
}

fn synthetic() -> Vec<String> {
    let mut lines: Vec<Value> = vec![
        // bookkeeping (hidden)
        json!({"type":"last-prompt","lastPrompt":"x","sessionId":"s"}),
        json!({"type":"mode","mode":"normal","sessionId":"s"}),
        json!({"type":"permission-mode","permissionMode":"plan","sessionId":"s"}),
        json!({"type":"ai-title","aiTitle":"A title","sessionId":"s"}),
        json!({"type":"queue-operation","operation":"enqueue","timestamp":ts(0)}),
        json!({"type":"file-history-snapshot","messageId":"m","snapshot":{}}),
        json!({"type":"pr-link","prUrl":"https://example.test/pr/1","prNumber":1}),
        json!({"type":"attachment","uuid":"at1","attachment":{"type":"total_tokens_reminder"}}),
        json!({"type":"attachment","uuid":"at2","attachment":{"type":"hook_success"}}),
        // user messages
        user(1, json!("plain question")),
        user(
            2,
            json!("<pasted_content id=\"1\">\nfolded text\n</pasted_content id=\"1\">"),
        ),
        user(
            3,
            json!([
                {"type":"text","text":"[Image #1] what is this"},
                {"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}}
            ]),
        ),
        user(
            4,
            json!("<command-name>/model</command-name>\n<command-args></command-args>"),
        ),
        user(
            5,
            json!("<local-command-stdout>\u{1b}[1mSet\u{1b}[22m model</local-command-stdout>"),
        ),
        user(6, json!("<bash-input>ls</bash-input>")),
        user(
            7,
            json!("<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>"),
        ),
        user(
            8,
            json!([{"type":"text","text":"[Request interrupted by user]"}]),
        ),
        // meta user line (hidden)
        {
            let mut v = user(9, json!("hook feedback"));
            v["isMeta"] = json!(true);
            v
        },
        // assistant
        assistant(
            10,
            json!([{"type":"thinking","thinking":"","signature":"sig"}]),
        ),
        assistant(
            11,
            json!([{"type":"thinking","thinking":"hmm","signature":"sig"}]),
        ),
        assistant(12, json!([{"type":"text","text":"**hello**"}])),
        assistant(
            13,
            json!([{"type":"tool_use","id":"t_bash","name":"Bash","input":{"command":"ls"}}]),
        ),
        result(14, "t_bash", json!("a.txt"), json!({})),
        assistant(
            15,
            json!([{"type":"tool_use","id":"t_edit","name":"Edit","input":{
                "file_path":"/x/y.rs","old_string":"a","new_string":"b"}}]),
        ),
        result(
            16,
            "t_edit",
            json!("edited"),
            json!({"toolUseResult":{"filePath":"/x/y.rs","structuredPatch":[
                {"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"lines":["-a","+b"]}]}}),
        ),
        assistant(
            17,
            json!([{"type":"tool_use","id":"t_deny","name":"Bash","input":{"command":"rm x"}}]),
        ),
        {
            let mut v = result(
                18,
                "t_deny",
                json!("The user doesn't want to proceed"),
                json!({}),
            );
            v["message"]["content"][0]["is_error"] = json!(true);
            v["toolDenialKind"] = json!("user-rejected");
            v
        },
        assistant(
            19,
            json!([{"type":"tool_use","id":"t_q","name":"AskUserQuestion","input":{"questions":[
                {"question":"Pick?","header":"P","multiSelect":false,
                 "options":[{"label":"A","description":"a"},{"label":"B","description":"b"}]}]}}]),
        ),
        result(
            20,
            "t_q",
            json!("answered"),
            json!({"toolUseResult":{"answers":{"Pick?":"B"}}}),
        ),
        assistant(
            21,
            json!([{"type":"tool_use","id":"t_plan","name":"ExitPlanMode","input":{"plan":"1. do it"}}]),
        ),
        result(22, "t_plan", json!("approved"), json!({})),
        assistant(
            23,
            json!([{"type":"tool_use","id":"t_agent","name":"Agent","input":{
                "description":"look around","subagent_type":"explore","prompt":"p"}}]),
        ),
        result(
            24,
            "t_agent",
            json!("done"),
            json!({"toolUseResult":{"status":"completed","agentId":"ag","totalToolUseCount":4}}),
        ),
        assistant(
            25,
            json!([{"type":"tool_use","id":"t_img","name":"mcp__x__shot","input":{}}]),
        ),
        result(
            26,
            "t_img",
            json!([{"type":"image","source":{"type":"base64","media_type":"image/png","data":"QUJD"}}]),
            json!({}),
        ),
        // orphan result (its tool_use is not in this stream)
        result(27, "t_orphan", json!("late"), json!({})),
        // system lines
        json!({"type":"system","subtype":"turn_duration","uuid":"s1","durationMs":65000}),
        json!({"type":"system","subtype":"compact_boundary","uuid":"s2",
               "compactMetadata":{"trigger":"auto","preTokens":100}}),
        json!({"type":"system","subtype":"away_summary","uuid":"s3","content":"recap"}),
        json!({"type":"system","subtype":"informational","uuid":"s4","content":"note"}),
        json!({"type":"system","subtype":"stop_hook_summary","uuid":"s5","hookErrors":[]}),
        json!({"type":"system","subtype":"local_command","uuid":"s6",
               "content":"<local-command-stdout>ok</local-command-stdout>"}),
        // queued prompt delivered mid-turn
        json!({"type":"attachment","uuid":"q1","attachment":{"type":"queued_command",
               "prompt":"queued words","source_uuid":"src1"}}),
        // API error
        json!({"type":"assistant","uuid":"e1","isApiErrorMessage":true,"error":"server_error",
               "message":{"model":"<synthetic>","content":[{"type":"text","text":"API Error: boom"}]}}),
        // unknown shapes: fallback
        json!({"type":"brand-new-kind","uuid":"f1","x":1}),
        json!({"type":"attachment","uuid":"f2","attachment":{"type":"never-seen-before"}}),
        assistant(28, json!([{"type":"server_tool_use","id":"z"}])),
    ];
    let mut out: Vec<String> = lines.drain(..).map(|v| v.to_string()).collect();
    out.push("{ this is not json".to_owned());
    out
}

fn dump(lines: &[String], trailing_newline: bool) -> (Value, String) {
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("t.jsonl");
    let mut f = std::fs::File::create(&p).unwrap();
    for (i, l) in lines.iter().enumerate() {
        if i + 1 < lines.len() || trailing_newline {
            writeln!(f, "{l}").unwrap();
        } else {
            write!(f, "{l}").unwrap();
        }
    }
    drop(f);
    let out = Command::new(BIN).arg("dump").arg(&p).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    (
        serde_json::from_slice(&out.stdout).unwrap(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn dump_maps_every_line_to_an_item_a_hidden_reason_or_a_fallback() {
    let lines = synthetic();
    let (v, err) = dump(&lines, false);
    let a = &v["accounting"];
    let n = lines.len() as u64;
    assert_eq!(a["lines"], n);
    assert_eq!(a["errors"], 1, "one invalid JSON line: {a}");
    let first = err.lines().next().unwrap();
    assert!(first.starts_with("lines="), "{err}");
    assert!(
        first.contains(" items=") && first.contains(" hidden=") && first.contains(" fallback=")
    );
    assert!(first.ends_with("errors=1"), "{first}");
    // N = mapped + hidden + fallback, and fallbacks are the 3 unknown shapes + the invalid JSON line.
    assert_eq!(a["fallback"], 3 + 1, "{err}");
    let hidden = a["hidden"].as_u64().unwrap();
    assert!(
        hidden >= 11,
        "bookkeeping and meta lines are hidden: {hidden}"
    );
    assert!(
        err.contains("fallback"),
        "reasons are listed on stderr: {err}"
    );
    assert!(err.contains("brand-new-kind") && err.contains("attachment:never-seen-before"));

    let items = v["items"].as_array().unwrap();
    assert_eq!(a["items"], items.len() as u64);
    let kinds: Vec<&str> = items.iter().map(|i| i["kind"].as_str().unwrap()).collect();
    for k in [
        "user",
        "assistant",
        "thinking",
        "tool",
        "question",
        "plan",
        "subagent",
        "system",
        "fallback",
    ] {
        assert!(kinds.contains(&k), "no {k} item in {kinds:?}");
    }
}

#[test]
fn dump_item_details() {
    let (v, _) = dump(&synthetic(), true);
    let items = v["items"].as_array().unwrap();
    let find = |k: &str| {
        items
            .iter()
            .find(|i| i["key"] == k)
            .unwrap_or_else(|| panic!("no item {k}"))
    };
    // User text: pasted wrapper unwrapped, images are refs, commands and shell lines map.
    assert_eq!(find("u1")["text"], "plain question");
    assert_eq!(find("u2")["text"], "folded text");
    let r = find("u3")["images"][0]["ref"].as_str().unwrap().to_owned();
    assert!(r.starts_with("main@") && r.ends_with("#0"), "{r}");
    assert_eq!(find("u3")["images"][0]["mediaType"], "image/png");
    assert_eq!(find("u4")["text"], "/model");
    assert_eq!(find("u5")["subtype"], "local_command");
    assert_eq!(find("u5")["text"], "Set model");
    assert_eq!(find("u6")["text"], "!ls");
    assert_eq!(find("u7")["subtype"], "bash_output");
    assert_eq!(find("u8")["subtype"], "interrupted");
    // Assistant blocks and tools.
    assert_eq!(find("a11:0")["kind"], "thinking");
    assert!(
        items.iter().all(|i| i["key"] != "a10:0"),
        "signature-only thinking is hidden"
    );
    assert_eq!(find("a12:0")["text"], "**hello**");
    assert_eq!(find("t_bash")["state"], "ok");
    assert_eq!(find("t_bash")["result"]["text"], "a.txt");
    assert_eq!(find("t_edit")["diff"]["hunks"][0]["lines"][1], "+b");
    assert_eq!(find("t_deny")["state"], "denied");
    assert_eq!(find("t_q")["state"], "answered");
    assert_eq!(find("t_q")["answers"]["Pick?"], "B");
    assert_eq!(find("t_plan")["state"], "approved");
    assert_eq!(find("t_agent")["kind"], "subagent");
    assert_eq!(find("t_agent")["agentType"], "explore");
    assert_eq!(find("t_agent")["itemCount"], 4);
    assert_eq!(find("t_agent")["state"], "ok");
    assert_eq!(
        find("t_img")["result"]["images"][0]["mediaType"],
        "image/png"
    );
    assert_eq!(find("t_orphan")["name"], "(unknown tool)");
    // System lines.
    assert_eq!(find("s1")["text"], "Worked for 1m 5s");
    assert!(find("s2")["text"].as_str().unwrap().contains("compacted"));
    assert_eq!(find("s3")["subtype"], "away_summary");
    assert_eq!(find("s4")["subtype"], "notice");
    assert!(
        items.iter().all(|i| i["key"] != "s5"),
        "an ok stop hook summary is hidden"
    );
    assert_eq!(find("s6")["text"], "ok");
    assert_eq!(find("e1:0")["subtype"], "api_error");
    // A queued prompt shows as the user's message.
    assert_eq!(find("queued:src1")["text"], "queued words");
    // Fallbacks keep the line type.
    assert_eq!(find("f1")["lineType"], "brand-new-kind");
    assert_eq!(find("f2")["lineType"], "attachment:never-seen-before");
}

#[test]
fn dump_usage_errors_exit_nonzero() {
    let out = Command::new(BIN).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    let out = Command::new(BIN)
        .args(["dump", "/nonexistent/x.jsonl"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(1));
    let out = Command::new(BIN)
        .args(["frobnicate", "x"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2));
}
