# -*- coding: utf-8 -*-
import os
d=os.path.dirname(os.path.abspath(__file__))
s=open(os.path.join(d,"app.html"),encoding="utf-8").read()
stars=open(os.path.join(d,"stars.js"),encoding="utf-8").read();planets=open(os.path.join(d,"planets.js"),encoding="utf-8").read()
import base64
font=base64.b64encode(open(os.path.join(d,"Pretendard.woff2"),"rb").read()).decode()
s=s.replace("<!--FONT-->","<style>@font-face{font-family:'Pretendard';src:url(data:font/woff2;base64,"+font+") format('woff2');font-weight:100 900;font-display:swap}</style>")
out=s.replace("<!--STARS-->","<script>"+stars+"</script>\n<script>"+planets+"</script>")
open(os.path.join(d,"planetory-proto.html"),"w",encoding="utf-8").write(out)
open(os.path.join(d,"index.html"),"w",encoding="utf-8").write("<!doctype html>\n<html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body>\n"+out+"\n</body></html>")
print("built",len(out.encode()))
