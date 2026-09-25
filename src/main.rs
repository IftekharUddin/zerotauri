// Windows release builds are GUI apps: no console window behind the UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    zerotauri::run();
}
