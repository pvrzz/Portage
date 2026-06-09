/*
Portage by pvrz
https://github.com/pvrzz/Portage/
File Name: background.js
*/

const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onInstalled.addListener(() => console.log("[Portage] installed."));

api.action.onClicked.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("dashboard.html") });
});
