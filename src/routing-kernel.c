// Host owns validated buffers; all geometry remains in Saxi.
#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif
__attribute__((import_module("env"), import_name("expired"))) extern int expired(void);
__attribute__((import_module("env"), import_name("exp"))) extern double host_exp(double);
#define INF (__builtin_inf())
static int minimum(int a, int b) { return a < b ? a : b; }
static int maximum(int a, int b) { return a > b ? a : b; }
static double edge(double *cost, int stride, int a, int b) { return cost[a * stride + b]; }
static void insert(int *list, int id, int fixed, int incoming, int length, int k, double *cost, int stride) {
  double value = incoming ? edge(cost,stride,id,fixed) : edge(cost,stride,fixed,id);
  if (length == k) {
    int last = list[k - 1];
    if (value >= (incoming ? edge(cost,stride,last,fixed) : edge(cost,stride,fixed,last))) return;
  }
  int at = 0;
  while (at < length) {
    int other = list[at];
    if ((incoming ? edge(cost,stride,other,fixed) : edge(cost,stride,fixed,other)) > value) break;
    at++;
  }
  for (int j = minimum(length,k-1); j > at; j--) list[j] = list[j-1];
  list[at] = id;
}
__attribute__((export_name("build"))) int build(int n, double *sx, double *sy, double *ex, double *ey,
    double a, double v, double *cost, int *out, int *into) {
  int stride = n + 1, k = minimum(12,n-1);
  double threshold = v * v / a;
  for (int i = 0; i <= n; i++) {
    if (expired()) return 0;
    int j = 0;
#ifdef __wasm_simd128__
    v128_t vx = wasm_f64x2_splat(ex[i]), vy = wasm_f64x2_splat(ey[i]);
    v128_t va = wasm_f64x2_splat(a), vv = wasm_f64x2_splat(v);
    v128_t vt = wasm_f64x2_splat(threshold), two = wasm_f64x2_splat(2);
    v128_t coast = wasm_f64x2_splat(v / a);
    for (; j + 1 <= n; j += 2) {
      v128_t dx = wasm_f64x2_sub(vx,wasm_v128_load(sx+j));
      v128_t dy = wasm_f64x2_sub(vy,wasm_v128_load(sy+j));
      v128_t d = wasm_f64x2_sqrt(wasm_f64x2_add(wasm_f64x2_mul(dx,dx),wasm_f64x2_mul(dy,dy)));
      v128_t slow = wasm_f64x2_mul(two,wasm_f64x2_sqrt(wasm_f64x2_div(d,va)));
      v128_t fast = wasm_f64x2_add(wasm_f64x2_div(d,vv),coast);
      wasm_v128_store(cost+i*stride+j,wasm_v128_bitselect(slow,fast,wasm_f64x2_le(d,vt)));
    }
#endif
    for (; j <= n; j++) {
      double dx=ex[i]-sx[j], dy=ey[i]-sy[j], d=__builtin_sqrt(dx*dx+dy*dy);
      cost[i*stride+j] = d <= threshold ? 2*__builtin_sqrt(d/a) : d/v+v/a;
    }
  }
  for (int i=0;i<n;i++) {
    if (expired()) return 0;
    int count=0;
    for(int j=0;j<n;j++) if(i!=j) {
      insert(out+i*k,j,i,0,count,k,cost,stride);
      insert(into+i*k,j,i,1,count,k,cost,stride);
      count=minimum(k,count+1);
    }
  }
  return 1;
}
static unsigned state;
static double random_value(void) { state=state*1664525u+1013904223u; return state/4294967296.0; }
static double score(int *order,int n,double *cost) {
  int s=n+1;
  double total=edge(cost,s,n,order[0])+edge(cost,s,order[n-1],n);
  for(int i=1;i<n;i++) total+=edge(cost,s,order[i-1],order[i]);
  return total;
}
static void anchor(int id,int *marks,int *anchors,int *length) {
  if(!marks[id]) { marks[id]=1; anchors[(*length)++]=id; }
}
static void gap(int j,int *marks,int generation,int *gaps,int *length) {
  if(marks[j]!=generation) { marks[j]=generation; gaps[(*length)++]=j; }
}
static void neighbor(int other,int n,int *positions,int *marks,int generation,int *gaps,int *length) {
  if(other!=n && positions[other]>=0) {
    gap(positions[other],marks,generation,gaps,length);
    gap(positions[other]+1,marks,generation,gaps,length);
  }
}
__attribute__((export_name("search"))) void search(int n,double *cost,int *out,int *into,int *offsets,
    int *conflicts,int *order,int iterations,int count,int *scratch,double *stats) {
  int s=n+1,k=minimum(12,n-1);
  int *current=scratch,*kept=current+s,*positions=kept+s,*pending=positions+s;
  int *anchors=pending+s,*anchorMark=anchors+s,*gapMark=anchorMark+s,*gaps=gapMark+s;
  int selected[64]; double ranks[64];
  for(int i=0;i<n;i++) current[i]=order[i];
  for(int i=0;i<s;i++) gapMark[i]=0;
  int generation=0; state=8675309u;
  for(int i=0;i<4;i++) stats[i]=0;
  double currentCost=score(current,n,cost),bestCost=currentCost,initialCost=currentCost;
  for(int iteration=0;iteration<iterations && !expired();iteration++) {
    int seedIndex=(int)(random_value()*n),seed=current[seedIndex];
    if(iteration%4==0) for(int i=0;i<count;i++) selected[i]=current[(seedIndex+i)%n];
    else {
      int length=0;
      for(int i=0;i<n;i++) {
        int id=current[i]; double rank=edge(cost,s,seed,id)+edge(cost,s,id,seed)+random_value()*0.1;
        if(length==count && rank>=ranks[count-1]) continue;
        int at=0; while(at<length && ranks[at]<=rank) at++;
        for(int j=minimum(length,count-1);j>at;j--) { ranks[j]=ranks[j-1]; selected[j]=selected[j-1]; }
        ranks[at]=rank; selected[at]=id; length=minimum(count,length+1);
      }
    }
    for(int i=0;i<s;i++) { pending[i]=0; anchorMark[i]=0; positions[i]=-1; }
    for(int i=0;i<count;i++) pending[selected[i]]=1;
    int keptLength=0,anchorLength=0;
    anchor(n,anchorMark,anchors,&anchorLength);
    for(int i=0;i<n;i++) {
      int id=current[i];
      if(pending[id]) {
        if(i && !pending[current[i-1]]) anchor(current[i-1],anchorMark,anchors,&anchorLength);
        if(i+1<n && !pending[current[i+1]]) anchor(current[i+1],anchorMark,anchors,&anchorLength);
      } else { positions[id]=keptLength; kept[keptLength++]=id; }
    }
    int failed=0;
    for(int remaining=count;remaining>0;remaining--) {
      if(expired()) { failed=1; break; }
      int chosen=-1,chosenGap=-1; double chosenRegret=-INF,chosenBest=INF;
      for(int r=0;r<count;r++) {
        int id=selected[r]; if(!pending[id]) continue;
        int lo=0,hi=keptLength,eligible=1;
        for(int c=offsets[id];c<offsets[id+1];c++) {
          int other=conflicts[c];
          if(pending[other]) { if(other<id) { eligible=0; break; } }
          else if(other<id) lo=maximum(lo,positions[other]+1);
          else hi=minimum(hi,positions[other]);
        }
        if(!eligible || lo>hi) continue;
        generation++; int gapLength=0;
        gap(lo,gapMark,generation,gaps,&gapLength); gap(hi,gapMark,generation,gaps,&gapLength);
        for(int j=0;j<k;j++) neighbor(into[id*k+j],n,positions,gapMark,generation,gaps,&gapLength);
        for(int j=0;j<k;j++) neighbor(out[id*k+j],n,positions,gapMark,generation,gaps,&gapLength);
        for(int j=0;j<anchorLength;j++) neighbor(anchors[j],n,positions,gapMark,generation,gaps,&gapLength);
        double first=INF,second=INF; int at=-1;
        for(int g=0;g<gapLength;g++) {
          int j=gaps[g]; if(j<lo || j>hi) continue;
          int a=j?kept[j-1]:n,b=j<keptLength?kept[j]:n;
          double delta=edge(cost,s,a,id)+edge(cost,s,id,b)-edge(cost,s,a,b);
          if(delta<first) { second=first;first=delta;at=j; }
          else if(delta<second) second=delta;
        }
        double regret=second-first;
        if(chosen<0 || regret>chosenRegret || (regret==chosenRegret && first<chosenBest)) {
          chosen=id;chosenGap=at;chosenRegret=regret;chosenBest=first;
        }
      }
      if(chosen<0) { failed=1;break; }
      for(int j=keptLength;j>chosenGap;j--) { kept[j]=kept[j-1];positions[kept[j]]=j; }
      kept[chosenGap]=chosen;positions[chosen]=chosenGap;keptLength++;pending[chosen]=0;
      anchor(chosen,anchorMark,anchors,&anchorLength);
    }
    stats[0]++;
    if(failed) { stats[1]++;continue; }
    double value=score(kept,n,cost);
    if(value<bestCost-1e-9) { for(int i=0;i<n;i++) order[i]=kept[i]; bestCost=value;stats[2]++; }
    double temperature=0.05*(1-(double)iteration/iterations);
    if(value<currentCost || random_value()<host_exp((currentCost-value)/temperature)) {
      for(int i=0;i<n;i++) current[i]=kept[i];currentCost=value;
    }
  }
  stats[3]=initialCost-bestCost;
}
