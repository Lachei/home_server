#include <iostream>
#include <crow.h>

#include "Credentials.hpp"

int main() {
    crow::SimpleApp app;
    
    Credentials credentials("credentials/cred.json");

    const std::string main_page_text = crow::mustache::load_text("main.html");
    CROW_ROUTE(app, "/")([&main_page_text](){
        return main_page_text;
    });
    
    CROW_ROUTE(app, "/get_salt/<string>")([&credentials](const std::string& user){
        return std::string(credentials.get_user_salt(user));
    });

    CROW_ROUTE(app, "/get_create_salt/<string>")([&credentials](const std::string& user){
        // TODO: should only be doable by the admin, maybe delete functionality
        return std::string(credentials.get_or_create_user_salt(user));
    });
    
    const std::string overview_page_admin = crow::mustache::load_text("overview_admin.html");
    const std::string overview_page_user = crow::mustache::load_text("overview_page_user.html");
    CROW_ROUTE(app, "/overview")([&overview_page_admin, &overview_page_user](){
        bool is_admin = true;
        if (is_admin)
            return overview_page_admin;
        else
            return overview_page_user;
    });

    app.bindaddr("127.0.0.22").port(18080).multithreaded().run();
    return 0;
}