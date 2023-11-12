#include <iostream>
#include <crow.h>

#include "Credentials.hpp"

struct AccessControlHeader{
    struct context{};
    
    void before_handle(crow::request& req, crow::response& res, context& ctx){}
    void after_handle(crow::request& req, crow::response& res, context& ctx){
        res.add_header("Access-Control-Allow-Origin", "*");
        res.add_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.add_header("Access-Control-Allow-Headers", "Content-Type");
        res.add_header("Access-Control-Allow-Credentials", "true");
    }
};

int main() {
    crow::App<AccessControlHeader> app;
    
    Credentials credentials("credentials/cred.json");

    const std::string main_page_text = crow::mustache::load_text("main.html");
    CROW_ROUTE(app, "/")([&main_page_text](){
        return main_page_text;
    });
    
    CROW_ROUTE(app, "/get_salt/<string>")([&credentials](const std::string& user){
        return credentials.get_user_salt(user);
    });

    CROW_ROUTE(app, "/get_create_salt/<string>")([&credentials](const std::string& user){
        // TODO: should only be doable by the admin, maybe delete functionality
        return credentials.get_or_create_user_salt(user);
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

    app.port(18080).multithreaded().run();
    return 0;
}