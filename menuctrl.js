    var $ = jQuery.noConflict();
$(window).load(function() {
	$('.pricechecker').hide();
  $('.flexslider').flexslider({
          animation: "fade"
    }); 

  	setInterval(function() { 		  $('.slides').show();
		  $('.pricechecker').hide();}, 20000);

	$(function() {
		$('.show_menu').click(function(){
				$('.menu').fadeIn();
				$('.show_menu').fadeOut();
				$('.hide_menu').fadeIn();
		});
		$('.hide_menu').click(function(){
				$('.menu').fadeOut();
				$('.show_menu').fadeIn();
				$('.hide_menu').fadeOut();
		});
	});
  });