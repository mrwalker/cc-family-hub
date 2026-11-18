sub init()
    m.top.functionName = "fetch"
end sub

sub fetch()
    cfg = m.top.config
    xfer = CreateObject("roUrlTransfer")
    xfer.SetUrl(cfg.url + "/api/widget?view=" + xfer.Escape(cfg.view))
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.RetainBodyOnError(true)
    xfer.AddHeader("Accept", "application/json")
    if cfg.clientId <> "" then
        xfer.AddHeader("CF-Access-Client-Id", cfg.clientId)
        xfer.AddHeader("CF-Access-Client-Secret", cfg.clientSecret)
    end if

    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    if not xfer.AsyncGetToString() then
        m.top.result = { error: "Couldn't start the request." }
        return
    end if
    msg = wait(20000, port)
    if msg = invalid then
        xfer.AsyncCancel()
        m.top.result = { error: "The hub didn't answer." }
        return
    end if

    code = msg.GetResponseCode()
    body = msg.GetString()
    data = invalid
    if Left(body, 1) = "{" then data = ParseJson(body)

    if code = 200 and data <> invalid and data.events <> invalid then
        m.top.result = { data: data }
    else if data <> invalid and data.error <> invalid then
        m.top.result = { error: data.error }
    else if code = 401 or code = 403 or Instr(1, body, "cloudflareaccess") > 0 then
        m.top.result = { error: "The hub didn't accept this channel's service token." }
    else if code = 404 then
        m.top.result = { error: "This hub has no /api/widget. It needs cc-family-hub v0.3.0 or later." }
    else if code < 0 then
        m.top.result = { error: "Network error: " + msg.GetFailureReason() }
    else
        m.top.result = { error: "The hub answered " + code.ToStr() + "." }
    end if
end sub
