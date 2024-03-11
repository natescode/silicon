function foo() {
  bar();
  return 69;
}

function bar() {
  return 420;
}

/*silicon
@fn foo = {
   #bar;
   69;  // foo returns 69
};

@fn foo = {
    @@inline 
    #bar; // copies code
}
*/
