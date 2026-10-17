use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const FILE_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct BotRecord {
    id: String,
    name: String,
    backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    added_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    draft: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct BotFile {
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    active: Option<String>,
    #[serde(default)]
    bots: Vec<BotRecord>,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BotEntry {
    pub id: String,
    pub name: String,
    pub backend: String,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub added_at: Option<String>,
    #[serde(default)]
    pub last_used_at: Option<String>,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub draft: Option<String>,
    #[serde(default)]
    pub needs_token: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BotsPayload {
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub bots: Vec<BotEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotsLoadResult {
    pub path: String,
    pub active: Option<String>,
    pub bots: Vec<BotEntry>,
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() % 2 != 0 {
        return Err("密文长度不是偶数，无法按十六进制解析".into());
    }
    let bytes = clean.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    let mut index = 0;
    while index < bytes.len() {
        let hi = (bytes[index] as char).to_digit(16).ok_or("密文含非十六进制字符")?;
        let lo = (bytes[index + 1] as char).to_digit(16).ok_or("密文含非十六进制字符")?;
        out.push(((hi << 4) | lo) as u8);
        index += 2;
    }
    Ok(out)
}

#[cfg(windows)]
mod dpapi {
    use std::ffi::c_void;
    use std::ptr;

    const UI_FORBIDDEN: u32 = 0x1;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            data_in: *const DataBlob,
            description: *const u16,
            entropy: *const DataBlob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            data_in: *const DataBlob,
            description: *mut *mut u16,
            entropy: *const DataBlob,
            reserved: *const c_void,
            prompt: *const c_void,
            flags: u32,
            data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(handle: *mut c_void) -> *mut c_void;
    }

    fn blob_of(data: &[u8]) -> DataBlob {
        DataBlob {
            cb_data: data.len() as u32,
            pb_data: data.as_ptr() as *mut u8,
        }
    }

    fn read_out(data_out: DataBlob) -> Vec<u8> {
        if data_out.pb_data.is_null() || data_out.cb_data == 0 {
            return Vec::new();
        }
        let owned = unsafe { std::slice::from_raw_parts(data_out.pb_data, data_out.cb_data as usize).to_vec() };
        unsafe { LocalFree(data_out.pb_data as *mut c_void) };
        owned
    }

    fn description() -> Vec<u16> {
        "MoeBot bot credentials".encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        if plain.is_empty() {
            return Ok(Vec::new());
        }
        let input = blob_of(plain);
        let label = description();
        let mut out = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(&input, label.as_ptr(), ptr::null(), ptr::null(), ptr::null(), UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(format!("Windows DPAPI 加密失败：{}", std::io::Error::last_os_error()));
        }
        Ok(read_out(out))
    }

    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        if cipher.is_empty() {
            return Ok(Vec::new());
        }
        let input = blob_of(cipher);
        let mut out = DataBlob { cb_data: 0, pb_data: ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(&input, ptr::null_mut(), ptr::null(), ptr::null(), ptr::null(), UI_FORBIDDEN, &mut out)
        };
        if ok == 0 {
            return Err(format!("Windows DPAPI 解密失败：{}", std::io::Error::last_os_error()));
        }
        Ok(read_out(out))
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(plain.to_vec())
    }
    pub fn unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
        Ok(cipher.to_vec())
    }
}

fn protect_text(plain: &str) -> Result<Option<String>, String> {
    if plain.is_empty() {
        return Ok(None);
    }
    Ok(Some(to_hex(&dpapi::protect(plain.as_bytes())?)))
}

fn unprotect_text(cipher: Option<&str>) -> Result<Option<String>, String> {
    let Some(cipher) = cipher.filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let bytes = from_hex(cipher)?;
    let plain = dpapi::unprotect(&bytes)?;
    Ok(Some(String::from_utf8_lossy(&plain).into_owned()))
}

fn bots_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?
        .join("bots");
    fs::create_dir_all(&dir).map_err(|error| format!("无法创建目录 {}：{error}", dir.display()))?;
    Ok(dir)
}

fn bots_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(bots_dir(app)?.join("bots.yml"))
}

fn normalize(entry: BotEntry) -> Result<BotRecord, String> {
    let backend = entry.backend.trim().trim_end_matches('/').to_string();
    if entry.id.trim().is_empty() {
        return Err("机器人缺少 id".into());
    }
    if backend.is_empty() {
        return Err("机器人缺少后端地址".into());
    }
    let name = if entry.name.trim().is_empty() {
        backend
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap_or(&backend)
            .to_string()
    } else {
        entry.name.trim().to_string()
    };
    let clean = |value: Option<String>| value.map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
    Ok(BotRecord {
        id: entry.id.trim().to_string(),
        name,
        backend,
        account_id: clean(entry.account_id),
        project_name: clean(entry.project_name),
        added_at: clean(entry.added_at),
        last_used_at: clean(entry.last_used_at),
        token: protect_text(&entry.token)?,
        draft: clean(entry.draft).map(|json| protect_text(&json)).transpose()?.flatten(),
    })
}

#[tauri::command]
pub fn bots_load(app: tauri::AppHandle) -> Result<BotsLoadResult, String> {
    let path = bots_path(&app)?;
    let path_text = path.display().to_string();
    if !path.exists() {
        return Ok(BotsLoadResult { path: path_text, active: None, bots: Vec::new() });
    }
    let text = fs::read_to_string(&path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(BotsLoadResult { path: path_text, active: None, bots: Vec::new() });
    }
    let file: BotFile = serde_yaml::from_str(&text)
        .map_err(|error| format!("{path_text} 解析失败：{error}"))?;
    let mut bots = Vec::with_capacity(file.bots.len());
    for record in file.bots {
        let mut needs_token = false;
        let token = match unprotect_text(record.token.as_deref()) {
            Ok(value) => value.unwrap_or_default(),
            Err(_) => {
                needs_token = true;
                String::new()
            }
        };
        if token.is_empty() && !needs_token && record.token.is_some() {
            needs_token = true;
        }
        let draft = unprotect_text(record.draft.as_deref()).ok().flatten();
        bots.push(BotEntry {
            id: record.id,
            name: record.name,
            backend: record.backend,
            account_id: record.account_id,
            project_name: record.project_name,
            added_at: record.added_at,
            last_used_at: record.last_used_at,
            token,
            draft,
            needs_token,
        });
    }
    Ok(BotsLoadResult { path: path_text, active: file.active, bots })
}

#[tauri::command]
pub fn bots_save(app: tauri::AppHandle, payload: BotsPayload) -> Result<String, String> {
    let path = bots_path(&app)?;
    let mut bots = Vec::with_capacity(payload.bots.len());
    for entry in payload.bots {
        bots.push(normalize(entry)?);
    }
    let active = payload.active.filter(|id| bots.iter().any(|record| &record.id == id));
    let file = BotFile { version: FILE_VERSION, active, bots };
    let body = serde_yaml::to_string(&file).map_err(|error| format!("无法序列化机器人列表：{error}"))?;
    let header = "# MoeBot 机器人列表（桌面端自动维护，可手工编辑）\n\
                  # token 与 draft 为 Windows DPAPI 密文，只有当前 Windows 用户能解密。\n";
    let temp = path.with_extension("yml.tmp");
    fs::write(&temp, format!("{header}{body}"))
        .map_err(|error| format!("无法写入 {}：{error}", temp.display()))?;
    fs::rename(&temp, &path).map_err(|error| format!("无法替换 {}：{error}", path.display()))?;
    Ok(path.display().to_string())
}
