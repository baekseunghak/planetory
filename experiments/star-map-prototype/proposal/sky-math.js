/* ICRS directions on a unit celestial sphere. North up, east to the left. */
(() => {
  const R = Math.PI / 180;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wrap = x => ((x % 360) + 360) % 360;
  const vector = (ra, dec) => [Math.cos(dec*R)*Math.cos(ra*R), Math.cos(dec*R)*Math.sin(ra*R), Math.sin(dec*R)];
  const dot = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const direction = p => ({ra:wrap(Math.atan2(p[1],p[0])/R),dec:Math.atan2(p[2],Math.hypot(p[0],p[1]))/R});
  const frame = view => ({forward:vector(view.ra,view.dec),right:[Math.sin(view.ra*R),-Math.cos(view.ra*R),0],up:[-Math.sin(view.dec*R)*Math.cos(view.ra*R),-Math.sin(view.dec*R)*Math.sin(view.ra*R),Math.cos(view.dec*R)]});
  function project(p, view, size) {
    const b=frame(view), z=dot(p,b.forward), f=size.h/(2*Math.tan(view.fov*R/2));
    return {x:size.w/2+f*dot(p,b.right)/Math.max(z,.00001),y:size.h*.40-f*dot(p,b.up)/Math.max(z,.00001),z,visible:z>.02};
  }
  function unproject(x,y,view,size) {
    const b=frame(view),f=size.h/(2*Math.tan(view.fov*R/2));
    return direction(b.forward.map((v,i)=>v+(x-size.w/2)/f*b.right[i]-(y-size.h*.40)/f*b.up[i]));
  }
  const separation = (a,b) => Math.acos(clamp(dot(vector(a.ra,a.dec),vector(b.ra,b.dec)),-1,1))/R;
  function interpolate(a,b,t) {
    const av=vector(a.ra,a.dec),bv=vector(b.ra,b.dec),theta=Math.acos(clamp(dot(av,bv),-1,1));
    if(theta<1e-7)return {...b};
    const sin=Math.sin(theta);
    // Our three targets are not antipodal. Guard any future exact antipode input.
    if(Math.abs(sin)<1e-6)return {ra:wrap(a.ra+(((b.ra-a.ra+540)%360)-180)*t),dec:a.dec+(b.dec-a.dec)*t};
    return direction(av.map((v,i)=>(Math.sin((1-t)*theta)*v+Math.sin(t*theta)*bv[i])/sin));
  }
  const api={R,clamp,wrap,vector,dot,direction,frame,project,unproject,separation,interpolate};
  if(typeof module!=='undefined')module.exports=api;
  else window.SkyMath=api;
})();
