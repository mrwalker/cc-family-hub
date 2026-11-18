/**
 * Grocery-list email for the hub's Shopping module.
 *
 * Setup: script.google.com → New project → paste this file → Deploy → New
 * deployment → Web app (Execute as: Me, Who has access: Anyone). Put the web
 * app URL in your family.yaml as hub.groceryEmailUrl. Mail is sent from the
 * Google account that deployed it.
 *
 * Anyone with the URL can make it send mail, so keep it private (it's served
 * to the page only through /api/config.js, behind your hub's auth).
 */
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var recipient = data.email;
    var items = data.items;
    
    var body = "Here is the grocery list:\n\n";
    for (var i = 0; i < items.length; i++) {
      var qty = items[i].qty || 1;
      body += "- " + qty + "x " + items[i].text + "\n";
    }
    
    if (recipient && items.length > 0) {
      MailApp.sendEmail({
        to: recipient,
        subject: data.subject || "Grocery List",
        body: body
      });
    }
    
    return ContentService.createTextOutput(JSON.stringify({"status": "success"}))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({"error": err.toString()}))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
